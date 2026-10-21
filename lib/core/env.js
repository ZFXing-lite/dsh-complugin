/**
 * dsh-complugin — the per-module context shim.
 *
 * Every module in this plugin started life as a standalone plugin with its own
 * cordis `apply(ctx, config)` and its own settings namespace. Keeping those
 * bodies untouched is deliberate: they are behaviour-locked by their own test
 * suites, and a merge that rewrites them would silently change what DSH does.
 *
 * So the merge supplies the one thing that has to be shared — configuration —
 * through a thin `ctx` proxy:
 *
 * - `ctx.settings.register(ns, schema, opts)` is answered from the merged
 *   `complugin` namespace instead of creating a namespace of its own;
 * - `ctx.inject(deps, cb)` hands the callback a proxied context, so a module
 *   that asks for `settings` gets the same merged scope;
 * - `ctx.logger` is prefixed and recorded, which gives the panel a status line
 *   for a module whose internal state is private.
 *
 * Everything else (`ctx.on`, `ctx.effect`, `ctx.agents`, `ctx.commands`, …)
 * passes straight through to the real context.
 *
 * @module dsh-complugin/core/env
 */
import os from "node:os";
import path from "node:path";

/** Resolve `$DSH_HOME` the way the rest of the harness does. */
export function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	return path.join(os.homedir(), ".dsh");
}

/** Turn any thrown value into one readable line. */
export function renderThrown(error) {
	if (error instanceof Error) return error.message === "" ? error.name : error.message;
	return String(error ?? "未知错误");
}

/**
 * A tiny bounded log ring per module.
 * @param {number} [limit] - how many lines to keep.
 * @returns {{push: (level: string, message: string) => void, last: () => object|undefined, list: () => object[], counts: () => object}}
 */
export function createLogRing(limit = 40) {
	const lines = [];
	const counts = { info: 0, warn: 0, error: 0 };
	return {
		push(level, message) {
			const entry = { level, message: String(message ?? ""), at: Date.now() };
			lines.push(entry);
			if (lines.length > limit) lines.shift();
			if (counts[level] !== undefined) counts[level] += 1;
		},
		last() {
			return lines.length === 0 ? undefined : lines[lines.length - 1];
		},
		list() {
			return [...lines];
		},
		counts() {
			return { ...counts };
		}
	};
}

/**
 * Build the shared environment handed to every module.
 *
 * The host owns settings and mounting; a module only ever sees this object, so
 * a module cannot corrupt another module's state or reach the raw scope.
 *
 * @param {object} spec - `{ ctx, logger, modules, patch, home, read, readRaw, notify, onChange, write, store }`.
 * @returns {object} the environment.
 */
export function createEnv(spec) {
	/** Current normalized configuration. */
	const config = () => spec.read();
	return {
		ctx: spec.ctx,
		logger: spec.logger,
		modules: spec.modules,
		patch: spec.patch,
		home: spec.home,
		read: spec.read,
		readRaw: spec.readRaw,
		notify: spec.notify,
		config,
		module: (id) => {
			const current = config();
			const section = current?.modules?.[id];
			return section !== null && typeof section === "object" ? section : {};
		},
		/** Replace one module's whole section (values are normalized by the host). */
		updateModule: async (id, values) => {
			const current = config();
			const section = current?.modules?.[id] ?? {};
			const nextModules = { ...current.modules, [id]: { ...section, ...values } };
			await spec.write(nextModules, current.enabled);
			spec.notify();
		},
		onChange: spec.onChange,
		store: spec.store,
		write: spec.write
	};
}

/**
 * Build the `ctx` one module sees.
 *
 * @param {object} env - the shared environment from `lib/index.js`.
 * @param {object} module - the module declaration.
 * @returns {object} a `ctx`-shaped proxy.
 */
export function createModuleContext(env, module) {
	const id = module.id;
	const ring = createLogRing(60);
	const record = (level) => (...args) => {
		const message = args.map((value) => (typeof value === "string" ? value : renderThrown(value))).join(" ");
		ring.push(level, message);
		const sink = env.logger?.[level] ?? env.logger?.info;
		sink?.(`[${id}] ${message}`);
	};
	const logger = {
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
		debug: record("info"),
		success: record("info")
	};

	/**
	 * A settings scope over the merged namespace.
	 *
	 * `get()` returns this module's own normalized section, so a module reading
	 * `scope.get().readyRatio` keeps working; `watch()` fires whenever the
	 * merged value changes.
	 */
	const mergedScope = {
		get: () => env.module(id),
		watch: (callback) => env.onChange(() => callback()),
		update: (patch) => env.updateModule(id, patch),
		replace: (section) => env.updateModule(id, section)
	};

	const settingsLike = {
		register: () => mergedScope,
		get: () => mergedScope.get(),
		describe: () => []
	};

	/** Services a module sees: real ones, except `settings`. */
	const projectScope = (source) => new Proxy(source, {
		get(target, key, receiver) {
			if (key === "settings") return settingsLike;
			if (key === "logger") return logger;
			return Reflect.get(target, key, receiver);
		},
		has(target, key) {
			if (key === "settings" || key === "logger") return true;
			return Reflect.has(target, key);
		}
	});

	const shim = new Proxy(env.ctx, {
		get(target, key, receiver) {
			if (key === "logger") return logger;
			if (key === "settings") return settingsLike;
			if (key === "inject") {
				return (deps, callback) => {
					const list = Array.isArray(deps) ? deps : [deps];
					return target.inject(list, (sctx) => callback(projectScope(sctx)));
				};
			}
			if (key === "effect") {
				return (execute, label) => target.effect(execute, label === undefined ? `complugin/${id}` : `complugin/${id}: ${label}`);
			}
			return Reflect.get(target, key, receiver);
		},
		has(target, key) {
			if (key === "logger" || key === "settings" || key === "inject" || key === "effect") return true;
			return Reflect.has(target, key);
		}
	});

	return {
		ctx: shim,
		logger,
		ring,
		/** Panel status derived from the ring plus the module's own state. */
		status() {
			const last = ring.last();
			const counts = ring.counts();
			const config = env.module(id);
			const enabled = config.enabled !== false && env.config().enabled !== false;
			const entries = ring.list().slice(-6).reverse().map((entry) => ({
				level: entry.level,
				text: entry.message,
				at: entry.at
			}));
			return {
				ready: enabled,
				sign: counts.error > 0 && last?.level === "error" ? "error" : enabled ? "on" : "off",
				badge: enabled ? "运行中" : "已停用",
				line: last === undefined ? "等待首次事件" : last.message,
				entries,
				stats: [
					{ label: "日志", value: String(counts.info) },
					{ label: "警告", value: String(counts.warn) },
					{ label: "错误", value: String(counts.error) }
				]
			};
		}
	};
}
