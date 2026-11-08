/**
 * dsh-complugin — 重试调整（模块）
 *
 * ── 问题 ──────────────────────────────────────────────────────────────────
 *
 * DSH 的模型请求重试策略硬编码在 `@deepseek-ai/dsh-llm/lib/types/retry-policy.js`：
 *   DEFAULT_MAX_RETRIES    = 5
 *   DEFAULT_INITIAL_DELAY_MS = 500
 *   DEFAULT_MAX_DELAY_MS    = 10_000
 *   DEFAULT_JITTER_RATIO    = 0.1
 *
 * 当模型连续失败时，DSH 会重试 5 次（指数退避 500ms→10s），每次都向上下文
 * 注入错误信息。如果「自动继续」也在跑，两者叠加会批量污染上下文。
 *
 * ── 实现 ─────────────────────────────────────────────────────────────────
 *
 * 文件补丁：替换 4 个 DEFAULT 常量。补丁的 find/replace/marker 是动态的——
 * 根据用户在面板里填的值生成。这样用户改参数→点「应用」→文件就更新。
 * 升级 DSH 会覆盖，面板的「重新检测」会发现并提示重打。
 *
 * @module dsh-complugin/modules/retry-tuning
 */
import { defineModule } from "../core/registry.js";
import { definePatch } from "../core/hostpatch.js";
import { renderThrown } from "../core/env.js";

/** 原始 4 行常量（补丁锚点）。 */
const ORIGINAL_LINES =
	"const DEFAULT_MAX_RETRIES = 5;\n"
	+ "const DEFAULT_INITIAL_DELAY_MS = 500;\n"
	+ "const DEFAULT_MAX_DELAY_MS = 10_000;\n"
	+ "const DEFAULT_JITTER_RATIO = 0.1;";

/** 标记补丁在位的 marker——补丁后的第一行带特殊注释。 */
const PATCH_MARKER = "/* dsh-complugin:retry-tuning */";

/**
 * 根据用户配置生成补丁后的 4 行。
 * @param {object} cfg - `{ maxRetries, initialDelayMs, maxDelayMs, jitterRatio }`.
 * @returns {string} 替换文本。
 */
function patchedLines(cfg) {
	return `${PATCH_MARKER}\n`
		+ `const DEFAULT_MAX_RETRIES = ${cfg.maxRetries};\n`
		+ `const DEFAULT_INITIAL_DELAY_MS = ${cfg.initialDelayMs};\n`
		+ `const DEFAULT_MAX_DELAY_MS = ${cfg.maxDelayMs};\n`
		+ `const DEFAULT_JITTER_RATIO = ${cfg.jitterRatio};`;
}

/**
 * 动态生成补丁描述符。
 *
 * `definePatch` 要求 find/replace/marker 是字符串，所以我们按当前配置生成。
 * 补丁服务用 find 做锚点检测、marker 做在位检测——只要 marker 在文件里，
 * 就算"已应用"，不管具体值是什么（用户可能多次调参）。
 *
 * @param {object} cfg - 当前生效配置。
 * @returns {object} 补丁描述符。
 */
function makePatch(cfg) {
	return definePatch({
		id: "retry-tuning",
		label: "重试参数（文件补丁）",
		package: "@deepseek-ai/dsh-llm",
		file: "lib/types/retry-policy.js",
		find: ORIGINAL_LINES,
		replace: patchedLines(cfg),
		marker: PATCH_MARKER,
		note: "改 dsh-llm 的重试默认常量，升级 DSH 后需要重打。"
	});
}

/**
 * 尝试读取当前 provider 的重试策略，用于面板展示。
 * @param {object} ctx - 宿主上下文。
 * @returns {object|null} `{ maxRetries, initialDelayMs, maxDelayMs, jitterRatio }` 或 null。
 */
function readLivePolicy(ctx) {
	try {
		const llm = ctx?.llm;
		if (llm === null || llm === undefined) return null;
		const providers = typeof llm.listProviders === "function" ? llm.listProviders() : [];
		if (providers.length === 0) return null;
		const first = providers[0];
		const policy = typeof llm.providerRetryPolicy === "function" ? llm.providerRetryPolicy(first.id) : undefined;
		if (policy === null || policy === undefined) return null;
		return {
			maxRetries: policy.maxRetries ?? 5,
			initialDelayMs: policy.initialDelayMs ?? 500,
			maxDelayMs: policy.maxDelayMs ?? 10000,
			jitterRatio: policy.jitterRatio ?? 0.1
		};
	} catch {
		return null;
	}
}

/** Module declaration. */
export default defineModule({
	id: "retryTuning",
	kind: "patch",
	order: 35,
	title: "重试调整",
	summary: "调节模型请求的重试次数与退避延迟，减少重试对上下文的污染。",
	legacy: "",
	docs: "改 dsh-llm 的重试默认常量（maxRetries / initialDelayMs / maxDelayMs / jitterRatio）。补丁应用后需重启 DSH 生效。升级 DSH 会覆盖，需重打。",
	fields: [
		{
			key: "maxRetries",
			label: "最大重试次数",
			type: "number",
			group: "basic",
			default: 5,
			min: 0,
			max: 20,
			step: 1,
			hint: "0 = 不重试，5 = DSH 默认。次数越多，失败时往上下文注入的错误越多。"
		},
		{
			key: "initialDelayMs",
			label: "首次重试延迟(ms)",
			type: "number",
			group: "basic",
			default: 500,
			min: 100,
			max: 60000,
			step: 100,
			hint: "第一次重试前等多少毫秒。指数退避的基数。"
		},
		{
			key: "maxDelayMs",
			label: "最大重试延迟(ms)",
			type: "number",
			group: "tuning",
			default: 10000,
			min: 1000,
			max: 120000,
			step: 500,
			hint: "退避延迟的上限。到达后不再翻倍。"
		},
		{
			key: "jitterRatio",
			label: "抖动比例",
			type: "number",
			group: "tuning",
			default: 0.1,
			min: 0,
			max: 1,
			step: 0.05,
			hint: "0 = 无抖动，0.1 = DSH 默认。加抖动防止多个请求同步重试。"
		}
	],
	actions: [
		{ id: "recheck", label: "重新检测", desc: "重新检查补丁状态与当前生效值", tone: "ghost" }
	],
	patch: makePatch({ maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }),
	patchFactory: (cfg) => makePatch({
		maxRetries: cfg.maxRetries ?? 5,
		initialDelayMs: cfg.initialDelayMs ?? 500,
		maxDelayMs: cfg.maxDelayMs ?? 10000,
		jitterRatio: cfg.jitterRatio ?? 0.1
	}),
	mount({ ctx, env, logger, config, patcher }) {
		let state = { ok: false, detail: "尚未检测" };
		let disposed = false;

		/** 用当前配置重新生成补丁描述符并检测状态。 */
		const checkState = async () => {
			const current = config();
			const patch = makePatch(current);
			try {
				const status = await patcher.status(patch);
				const live = readLivePolicy(ctx);
				const liveStr = live === null ? "未知" : `${live.maxRetries} 次 / ${live.initialDelayMs}ms / 上限 ${live.maxDelayMs}ms`;
				if (status.state === "applied") {
					state = { ok: true, detail: `补丁在位（当前生效：${liveStr}）` };
				} else if (status.state === "clean") {
					state = { ok: true, detail: `未打补丁（当前生效：${liveStr}）` };
				} else if (status.state === "missing") {
					state = { ok: false, detail: `找不到目标文件：${status.detail}` };
				} else {
					state = { ok: false, detail: status.detail };
				}
			} catch (error) {
				state = { ok: false, detail: `检测失败：${renderThrown(error)}` };
			}
		};

		void checkState();
		env.onChange(() => { void checkState(); });
		ctx.effect(() => () => { disposed = true; }, "retry-tuning: cleanup");

		return {
			status: () => {
				const current = config();
				const live = readLivePolicy(ctx);
				const configured = `${current.maxRetries} 次 / ${current.initialDelayMs}ms / 上限 ${current.maxDelayMs}ms`;
				const liveStr = live === null ? "未知" : `${live.maxRetries} 次 / ${live.initialDelayMs}ms`;
				const patchApplied = state.detail.startsWith("补丁在位");
				return {
					ready: true,
					sign: patchApplied ? "on" : "idle",
					badge: patchApplied ? "已调整" : "默认值",
					line: `配置：${configured} · 生效：${liveStr}`,
					entries: [{ level: state.ok ? "info" : "warn", text: state.detail, at: 0 }],
					stats: [
						{ label: "配置次数", value: current.maxRetries },
						{ label: "生效次数", value: live?.maxRetries ?? "?" }
					]
				};
			},
			actions: {
				recheck: async () => {
					await checkState();
					return { ok: state.ok, detail: state.detail };
				}
			}
		};
	}
});
