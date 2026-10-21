/**
 * dsh-complugin — 推理等级默认可见（模块）
 *
 * ── 问题 ──────────────────────────────────────────────────────────────────
 *
 * 在 `settings.yaml` 里手写声明的 provider/模型，只写 `id` 与 `name`，没有
 * `reasoningEfforts`。DSH 的 `dsh-llm-pi-ai` 于是给它们 `reasoning: false`，
 * 模型选择菜单里那一行「推理等级」永远不会渲染 —— 前端只认
 * `reasoning !== undefined`。
 *
 * ── 两条实现路径 ─────────────────────────────────────────────────────────
 *
 * 1. **运行时接管（默认）**：`PiAiAdapter.prototype.modelOf` 是所有取值路径的
 *    唯一出口 —— `modelInfo()`（前端目录 RPC）、`prepareCall()`（请求前准备）、
 *    `streamWithSnapshot()`（真正发请求）都经过它。把返回的模型描述补上
 *    `reasoning: true` 与 `thinkingLevelMap`，菜单立刻出现档位，请求侧
 *    `resolveReasoningLevel` 也能通过校验，pi-ai 最终写入
 *    `reasoning_effort`。插件卸载即恢复，不碰磁盘，升级 DSH 也不会丢。
 *
 * 2. **文件补丁（可选）**：把 `resolveModelReasoning` 里那行单行分支换成三行。
 *    这是历史做法，效果等价，但 `npm i -g` 会覆盖掉。留在面板里是为了
 *    可回滚、可见，不是推荐路径。两条路径同时存在也不会翻倍生效 ——
 *    wrap 只在 `model.reasoning === undefined` 时补，已经声明过的不动。
 *
 * @module dsh-complugin/modules/reasoning-effort
 */
import { defineModule } from "../core/registry.js";
import { definePatch } from "../core/hostpatch.js";
import { renderThrown } from "../core/env.js";

/** Marks the wrapped prototype method; shared across reloads of this plugin. */
const WRAP_MARK = Symbol.for("dsh-complugin/reasoning-effort/modelOf");

/** 可提供的档位（pi-ai 的 wire 名）。 */
const OFFERED_LEVELS = Object.freeze(["low", "medium", "high"]);

/**
 * 文件补丁：让 `resolveModelReasoning` 的「未声明」分支默认开启推理等级。
 * 锚点为单行原文，出现次数必须恰好一次，否则服务端中止且不改文件。
 */
const FILE_PATCH = definePatch({
	id: "reasoning-effort",
	label: "推理等级默认可见（文件补丁）",
	package: "@deepseek-ai/dsh-llm-pi-ai",
	file: "lib/index.js",
	find: "\tif (efforts === void 0) return { reasoning: base?.reasoning ?? false };",
	replace:
		"\tif (efforts === void 0) {\n"
		+ "\t\tif (base?.reasoning !== void 0) return { reasoning: base.reasoning };\n"
		+ "\t\treturn { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: \"low\", medium: \"medium\", high: \"high\", xhigh: null, max: null } };\n"
		+ "\t}",
	marker: "thinkingLevelMap: { off",
	note: "改 dsh-llm-pi-ai 的私有函数，升级 DSH 后需要重打；运行时接管不需要。"
});

/**
 * 由一个档位列表生成 `thinkingLevelMap`。
 *
 * pi-ai 的规则：`null` = 不支持，`undefined` = 保留原状，其余值就是发出去的
 * wire 值。`off` 与 `minimal` 一律写 `null`——不替模型承诺它没有的档位。
 *
 * @param {readonly string[]} levels - 选中的档位。
 * @returns {Record<string, string|null>} pi-ai 认可的映射表。
 */
export function thinkingMapOf(levels) {
	const picked = (Array.isArray(levels) ? levels : []).filter((level) => OFFERED_LEVELS.includes(level));
	const effective = picked.length === 0 ? [...OFFERED_LEVELS] : [...new Set(picked)];
	const map = { off: null, minimal: null, xhigh: null, max: null };
	for (const level of effective) map[level] = level;
	return map;
}

/**
 * Decide whether a resolved model should be augmented.
 *
 * 只补「完全没声明」的模型：`false` 是用户的显式退出（`reasoningEfforts: false`），
 * 必须尊重；`true` 或对象说明上游已经给了能力，也不动。
 *
 * @param {unknown} model - the resolved pi-ai model descriptor.
 * @returns {boolean} whether to augment.
 */
export function shouldAugment(model) {
	return model !== null && typeof model === "object" && model.reasoning === undefined;
}

/**
 * Install the runtime takeover.
 *
 * @param {object} options - `{ map, logger }`.
 * @returns {Promise<{ok: boolean, detail: string, release?: () => void}>}
 */
export async function installRuntimeWrap(options) {
	const map = options?.map ?? thinkingMapOf(OFFERED_LEVELS);
	const logger = options?.logger;
	let mod;
	try {
		mod = await import("@deepseek-ai/dsh-llm-pi-ai");
	} catch (error) {
		return { ok: false, detail: `导入 dsh-llm-pi-ai 失败：${renderThrown(error)}` };
	}
	const Adapter = mod?.PiAiAdapter;
	if (typeof Adapter !== "function") return { ok: false, detail: "dsh-llm-pi-ai 没有导出 PiAiAdapter（版本可能已变）" };
	const proto = Adapter.prototype;
	const existing = proto[WRAP_MARK];
	if (existing !== undefined && typeof existing === "object") {
		existing.map = map;
		return { ok: true, detail: "运行时接管已就位（档位已更新）", release: () => {} };
	}
	const original = proto.modelOf;
	if (typeof original !== "function") return { ok: false, detail: "PiAiAdapter.modelOf 不存在（版本可能已变）" };

	const record = { map, original };
	proto.modelOf = function modelOfWithReasoning(...args) {
		const model = original.apply(this, args);
		try {
			if (!shouldAugment(model)) return model;
			return { ...model, reasoning: true, thinkingLevelMap: { ...record.map } };
		} catch (error) {
			logger?.warn?.(`complugin: 推理等级接管跳过一次：${renderThrown(error)}`);
			return model;
		}
	};
	Object.defineProperty(proto.modelOf, "name", { value: "modelOf", configurable: true });
	proto[WRAP_MARK] = record;
	logger?.info?.(`complugin: 已接管 PiAiAdapter.modelOf，档位 ${Object.keys(map).filter((level) => map[level] !== null).join("/")}`);
	return {
		ok: true,
		detail: `运行时接管生效，档位 ${Object.keys(map).filter((level) => map[level] !== null).join(" / ")}`,
		release: () => {
			try {
				proto.modelOf = record.original;
				delete proto[WRAP_MARK];
				logger?.info?.("complugin: 已解除 PiAiAdapter.modelOf 接管");
			} catch {
				/* prototype already gone with the module */
			}
		}
	};
}

/** Module declaration consumed by `complugin`. */
export default defineModule({
	id: "reasoningEffort",
	kind: "hook",
	order: 40,
	title: "推理等级",
	summary: "让手写声明的模型也显示「推理等级」，low / medium / high 随手切。",
	legacy: "",
	docs: "默认走运行时接管：只在模型完全没声明 reasoning 时补能力，显式写 false 的模型不会被覆盖。文件补丁是等价的老做法，升级 DSH 会丢，留作可选。",
	fields: [
		{
			key: "mode",
			label: "接管方式",
			type: "select",
			group: "basic",
			default: "wrap",
			options: [
				{ value: "wrap", label: "运行时接管", hint: "改内存里的适配器，不碰磁盘，升级不丢（推荐）" },
				{ value: "off", label: "关闭", hint: "不改任何行为，档位按 DSH 原生规则显示" }
			],
			hint: "运行时接管对 PiAiAdapter 的取值出口打补丁，DSH 重启后由插件重新装上。"
		},
		{
			key: "levels",
			label: "提供的档位",
			type: "multi",
			group: "tuning",
			default: ["low", "medium", "high"],
			options: [
				{ value: "low", label: "Low", hint: "省 token，适合收尾和格式整理" },
				{ value: "medium", label: "Medium", hint: "默认档，日常平衡" },
				{ value: "high", label: "High", hint: "深度推理，慢但稳" }
			],
			hint: "选中的档位会出现在菜单里；全不选等于全选。"
		},
		{
			key: "filePatch",
			label: "同时打文件补丁",
			type: "switch",
			group: "advanced",
			default: false,
			hint: "仅在运行时接管不可用时作为兜底；开启后仍需在下方补丁区点「应用」。"
		}
	],
	actions: [
		{ id: "recheck", label: "重新检测", desc: "重新检查接管与补丁状态", tone: "ghost" }
	],
	patch: FILE_PATCH,
	mount({ ctx, env, logger, config }) {
		let release;
		let state = { ok: false, detail: "尚未安装" };
		let disposed = false;

		const install = async () => {
			const current = config();
			if (disposed) return;
			if (current.mode !== "wrap") {
				release?.();
				release = undefined;
				state = { ok: true, detail: "已关闭（不改动宿主行为）" };
				return;
			}
			const result = await installRuntimeWrap({ map: thinkingMapOf(current.levels), logger });
			if (result.ok) {
				release = result.release;
				state = { ok: true, detail: result.detail };
			} else {
				state = { ok: false, detail: result.detail };
				logger.warn(`complugin: 推理等级运行时接管未生效：${result.detail}`);
			}
		};

		void install();
		env.onChange(() => {
			void install();
		});
		ctx.effect(() => () => {
			disposed = true;
			release?.();
		}, "reasoning-effort: runtime wrap");

		return {
			status: () => {
				const current = config();
				const on = current.mode === "wrap" && state.ok;
				return {
					ready: on,
					sign: on ? "on" : current.mode === "wrap" ? "warn" : "idle",
					badge: on ? "接管中" : current.mode === "wrap" ? "未生效" : "已关闭",
					line: state.detail,
					entries: [{ level: state.ok ? "info" : "warn", text: state.detail, at: 0 }]
				};
			},
			actions: {
				recheck: async () => {
					await install();
					return { ok: state.ok, detail: state.detail };
				}
			}
		};
	}
});
