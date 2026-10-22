/**
 * dsh-complugin — host half.
 *
 * One plugin, one settings namespace, one panel. The four features that used to
 * be separate packages (自动压缩 / 自动继续 / 视觉桥 / 推理等级) are now modules of
 * this one, and the surface for adding a fifth is deliberately small:
 *
 * ```
 * lib/modules/my-thing.js
 *   export default defineModule({ id, title, fields, actions, mount })
 * lib/modules/index.js
 *   add it to the array
 * ```
 *
 * Nothing else needs to change: `defineModule` validates the declaration, the
 * host builds the settings schema from the fields, the panel renders whatever
 * `/api/complugin/status` describes, and a module that needs to patch DSH's own
 * source declares a `patch` descriptor instead of shipping shell scripts.
 *
 * @module dsh-complugin
 */
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import modules from "./modules/index.js";
import { defaultsFor, describeModule, normalizeConfig } from "./core/registry.js";
import { normalizeFields } from "./core/fields.js";
import { createEnv, createModuleContext, dshHome, renderThrown } from "./core/env.js";
import { createHostPatcher } from "./core/hostpatch.js";
import { createJsonStore } from "./core/store.js";
import { readLegacySettings } from "./core/legacy.js";
import { registerRoutes } from "./core/routes.js";

/** Cordis plugin name; must match the loader row id in `cordis.patch.yml`. */
export const name = "complugin";

/** Hard host requirements: the agent registry and the LLM runtime. */
export const inject = ["agents", "llm"];

/** The single settings namespace this plugin owns. */
export const NAMESPACE = "complugin";

/** Shown in the panel footer. */
const VERSION = "1.0.0";

/**
 * Settings schema.
 *
 * `modules` is intentionally untyped: every field's type, range and default is
 * declared by its own module (`defineField`), so a new module never needs a
 * schema edit here and a removed module's leftovers cannot break the read.
 */
export const SettingsSchema = z.object({
	enabled: z.boolean().default(true),
	modules: z.any().default({})
});

/** Log through the host logger, tagged so the source is obvious. */
function makeLogger(ctx) {
	const write = (level) => (...args) => {
		try {
			const message = args.map((value) => (typeof value === "string" ? value : renderThrown(value))).join(" ");
			// Keep the receiver: the host logger exposes its levels as accessors,
			// so a detached `sink(...)` call loses `this` and throws.
			const host = ctx?.logger;
			if (host === null || host === undefined) return;
			const sink = typeof host[level] === "function" ? level : "info";
			host[sink](`complugin: ${message}`);
		} catch {
			// Logging must never be the reason a plugin fails to load.
		}
	};
	return { info: write("info"), warn: write("warn"), error: write("error") };
}

/**
 * Install the merged plugin.
 * @param ctx - host context with `agents` and `llm` injected.
 * @param config - loader row config; used until the settings layer is ready.
 */
export function apply(ctx, config = {}) {
	const logger = makeLogger(ctx);
	const home = dshHome();
	const patchService = createHostPatcher({ logger, backupRoot: path.join(home, "complugin", "backups") });
	const stateStore = createJsonStore({ file: path.join(home, "complugin", "state.json"), logger });

	/** Base value from the loader row; replaced once settings answers. */
	let baseValue = normalizeConfig(modules, { ...defaultsFor(modules), ...(config?.modules ?? {}), enabled: config?.enabled !== false });
	/** The settings scope, once the service mounts. */
	let scope;
	/** `pending` until the modules are mounted; guards against a double mount. */
	let mountState = "pending";
	const listeners = new Set();
	/** module id → `{ api, context, error }`. */
	const mounted = new Map();
	/** patch id → last known state. */
	const patchStates = new Map();

	/** Current configuration, normalized against the mounted modules. */
	const read = () => {
		if (scope === undefined) return baseValue;
		try {
			return normalizeConfig(modules, scope.get());
		} catch (error) {
			logger.warn(`settings 读取失败，使用加载行配置：${renderThrown(error)}`);
			return baseValue;
		}
	};

	/** Raw (un-normalized) stored section, used to tell 「没设过」 from 「设成默认值」. */
	const rawValue = () => {
		if (scope === undefined) return {};
		try {
			const value = scope.get();
			return value !== null && typeof value === "object" ? value : {};
		} catch {
			return {};
		}
	};

	/** Tell every module and every listener that the configuration changed. */
	const notify = () => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (error) {
				logger.warn(`配置变更回调失败：${renderThrown(error)}`);
			}
		}
	};

	const env = createEnv({
		ctx,
		logger,
		modules,
		patch: patchService,
		home,
		read,
		readRaw: rawValue,
		notify,
		onChange(callback) {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
		async write(nextModules, enabled) {
			if (scope === undefined) throw new Error("settings 服务尚未就绪");
			baseValue = normalizeConfig(modules, { enabled, modules: nextModules });
			await scope.update({ enabled, modules: nextModules });
			notify();
		},
		store(storeName, options) {
			return createJsonStore({ file: path.join(home, "complugin", `${storeName}.json`), logger, ...options });
		}
	});

	// ── settings ─────────────────────────────────────────────────────────────
	try {
		ctx.inject(["settings"], (sctx) => {
			const settingsScope = sctx.settings.register(NAMESPACE, SettingsSchema, {
				base: { enabled: config?.enabled !== false, modules: config?.modules ?? {} }
			});
			scope = settingsScope;
			baseValue = normalizeConfig(modules, settingsScope.get());
			settingsScope.watch(() => {
				baseValue = normalizeConfig(modules, settingsScope.get());
				notify();
			});
			// A module mounted before the scope answered holds a defaults snapshot.
			// Mount (idempotent) and then broadcast once, so every module re-reads
			// its own row even when the early-mount fallback won the race.
			mountModules();
			notify();
			void importLegacySettings();
			logger.info(`配置就绪（enabled=${baseValue.enabled}，模块 ${modules.length} 个）`);
		});
	} catch (error) {
		logger.warn(`settings 命名空间不可用，使用加载行配置：${renderThrown(error)}`);
	}

	/**
	 * Inherit values from the four pre-merge namespaces once.
	 *
	 * Fill-only: a key is imported only when the merged section has never stored
	 * it. Anything the user then edits in the panel wins forever, and the old
	 * block on disk is left alone as a manual rollback path.
	 */
	async function importLegacySettings() {
		try {
			await stateStore.load();
			if (stateStore.get("legacyImported") === true) return;
			const namespaces = modules.map((module) => module.legacy).filter((legacy) => legacy !== "");
			if (namespaces.length === 0) return;
			const found = await readLegacySettings(path.join(home, "settings.yaml"), namespaces, logger);
			const raw = rawValue();
			const rawModules = raw?.modules !== null && typeof raw?.modules === "object" ? raw.modules : {};
			const nextModules = { ...rawModules };
			const imported = [];
			for (const module of modules) {
				if (module.legacy === "" || found[module.legacy] === undefined) continue;
				const stored = rawModules[module.id] !== null && typeof rawModules[module.id] === "object" ? rawModules[module.id] : {};
				const incoming = normalizeFields(module.fields, found[module.legacy]).value;
				const picked = {};
				for (const key of Object.keys(incoming)) {
					if (Object.hasOwn(stored, key)) continue;
					if (found[module.legacy][key] === undefined) continue;
					picked[key] = incoming[key];
				}
				if (Object.keys(picked).length === 0) continue;
				nextModules[module.id] = { ...stored, ...picked };
				imported.push(`${module.id}(${Object.keys(picked).join(",")})`);
			}
			if (imported.length > 0 && scope !== undefined) {
				await scope.update({ enabled: raw.enabled !== false, modules: nextModules });
				logger.info(`已从旧命名空间继承配置：${imported.join(" ")}`);
			}
			stateStore.set("legacyImported", true);
			await stateStore.flush();
		} catch (error) {
			logger.warn(`旧配置继承失败（不影响使用）：${renderThrown(error)}`);
		}
	}

	// ── modules ──────────────────────────────────────────────────────────────
	/**
	 * Mount every module exactly once.
	 *
	 * Deliberately deferred until the settings scope is live: a module reads its
	 * own configuration while mounting (each one is an ex-standalone plugin that
	 * snapshots its row on `apply`). Mounting before the scope resolves leaves
	 * that snapshot at defaults, and nothing short of a user save would ever
	 * refresh it — which is exactly how the vision bridge came up "not ready"
	 * after a restart that had nothing wrong with its stored config.
	 */
	function mountModules() {
		if (mountState !== "pending") return;
		mountState = "done";
		for (const module of modules) {
			try {
				const moduleContext = createModuleContext(env, module);
				const api = module.mount({
					env,
					ctx: moduleContext.ctx,
					logger: moduleContext.logger,
					ring: moduleContext.ring,
					config: () => env.module(module.id)
				}) ?? {};
				mounted.set(module.id, { api, context: moduleContext, error: "" });
				logger.info(`模块 ${module.id} 已挂载`);
			} catch (error) {
				mounted.set(module.id, { api: {}, context: undefined, error: renderThrown(error) });
				logger.error(`模块 ${module.id} 挂载失败：${renderThrown(error)}`);
			}
		}
	}

	/**
	 * Safety net: if no settings provider ever answers, mount anyway so the
	 * features keep working on the loader-row config alone.
	 */
	ctx.effect(() => {
		const timer = setTimeout(() => {
			if (mountState !== "pending") return;
			logger.warn("settings 服务未在预期时间内就绪，按加载行配置挂载模块");
			mountModules();
		}, 1500);
		return () => clearTimeout(timer);
	});

	/** Refresh every declared patch state; failures degrade to a status line. */
	async function refreshPatchStates() {
		for (const module of modules) {
			if (module.patch === null) continue;
			try {
				patchStates.set(module.patch.id, await patchService.status(module.patch));
			} catch (error) {
				patchStates.set(module.patch.id, {
					id: module.patch.id,
					label: module.patch.label,
					state: "missing",
					detail: renderThrown(error)
				});
			}
		}
	}

	/** Merge a module's own status with its log ring and module-level overrides. */
	function statusOf(module) {
		const entry = mounted.get(module.id);
		const base = entry?.context?.status();
		const fallback = {
			ready: false,
			sign: entry?.error === "" ? "idle" : "error",
			badge: entry?.error === "" ? "未挂载" : "挂载失败",
			line: entry?.error === "" ? "等待宿主事件" : entry?.error,
			entries: [],
			stats: []
		};
		let merged = { ...(base ?? fallback) };
		try {
			const extra = entry?.api?.status?.();
			if (extra !== null && typeof extra === "object") merged = { ...merged, ...extra };
		} catch (error) {
			merged.line = renderThrown(error);
			merged.sign = "error";
		}
		if (merged.entries === undefined) merged.entries = base?.entries ?? [];
		if (merged.stats === undefined) merged.stats = base?.stats ?? [];
		if (entry?.error !== "" && entry !== undefined) {
			merged.ready = false;
			merged.sign = "error";
			merged.badge = "挂载失败";
			merged.line = entry.error;
		}
		if (module.patch !== null) {
			const state = patchStates.get(module.patch.id);
			if (state !== undefined) merged.patch = state;
		}
		const configValue = read().modules[module.id] ?? {};
		if (module.kind === "hook" && configValue.enabled === false) {
			merged.sign = merged.sign === "error" ? "error" : "off";
			merged.badge = merged.badge === "挂载失败" ? merged.badge : "已停用";
		}
		if (read().enabled === false) {
			merged.ready = false;
			merged.sign = merged.sign === "error" ? "error" : "off";
		}
		return merged;
	}

	const api = {
		async status() {
			await refreshPatchStates();
			const current = read();
			return {
				plugin: { name: name, version: VERSION, enabled: current.enabled },
				namespace: NAMESPACE,
				modules: modules.map((module) => describeModule(module, {
					values: current.modules[module.id],
					status: statusOf(module),
					enabled: current.enabled
				}))
			};
		},

		async setMaster(enabled) {
			await env.write(read().modules, enabled === true);
			logger.info(`总开关已${enabled === true ? "开启" : "关闭"}`);
			return { ok: true, detail: enabled === true ? "已开启" : "已关闭" };
		},

		async updateModule(id, values) {
			const module = modules.find((candidate) => candidate.id === id);
			if (module === undefined) return { ok: false, detail: `未知模块：${id}` };
			const current = read();
			const stored = current.modules[id] ?? {};
			const merged = { ...stored };
			for (const [key, raw] of Object.entries(values ?? {})) {
				if (!module.fields.some((field) => field.key === key)) continue;
				merged[key] = raw;
			}
			const normalized = normalizeFields(module.fields, merged);
			const nextModules = { ...current.modules, [id]: normalized.value };
			try {
				await env.write(nextModules, current.enabled);
			} catch (error) {
				return { ok: false, detail: renderThrown(error) };
			}
			const note = normalized.problems.length === 0 ? "已保存" : `已保存（${normalized.problems.map((problem) => `${problem.key}: ${problem.note}`).join("；")}）`;
			logger.info(`${module.title}：${note}`);
			return { ok: true, detail: note };
		},

		async runAction(id, action, values) {
			const entry = mounted.get(id);
			if (entry === undefined) return { ok: false, detail: `未知模块：${id}` };
			const handler = entry.api?.actions?.[action];
			if (typeof handler !== "function") return { ok: false, detail: `模块 ${id} 没有动作 ${action}` };
			try {
				const result = await handler(values ?? {});
				return result !== null && typeof result === "object" ? result : { ok: true, detail: String(result ?? "") };
			} catch (error) {
				return { ok: false, detail: renderThrown(error) };
			}
		},

		async runPatch(id, action) {
			const module = modules.find((candidate) => candidate.id === id);
			if (module === undefined || module.patch === null) return { ok: false, detail: `模块 ${id} 没有声明补丁` };
			if (action === "status") {
				const state = await patchService.status(module.patch);
				patchStates.set(module.patch.id, state);
				return { ok: true, detail: state.detail };
			}
			if (action !== "apply" && action !== "revert") return { ok: false, detail: `未知补丁动作：${action}` };
			const result = action === "apply" ? await patchService.apply(module.patch) : await patchService.revert(module.patch);
			patchStates.set(module.patch.id, await patchService.status(module.patch));
			return result;
		}
	};

	// ── panel API ────────────────────────────────────────────────────────────
	registerRoutes({ ctx, logger, api });

	// ── teardown ─────────────────────────────────────────────────────────────
	ctx.effect(() => () => {
		for (const [id, entry] of mounted) {
			try {
				entry.api?.dispose?.();
			} catch (error) {
				logger.warn(`模块 ${id} 清理失败：${renderThrown(error)}`);
			}
		}
		mounted.clear();
		listeners.clear();
		void stateStore.dispose();
	}, "complugin: lifecycle");

	logger.info(`已加载 ${modules.length} 个模块（${modules.map((module) => module.title).join("、")}）`);
}

export { describeModule };
