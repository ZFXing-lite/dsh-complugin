/**
 * dsh-complugin — 重试调整（模块）
 *
 * ── 问题 ──────────────────────────────────────────────────────────────────
 *
 * DSH 的模型请求重试策略硬编码在 `@deepseek-ai/dsh-llm` 的 bundle 里：
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
 * 双通道策略：
 *
 * 1. settings 注入（推荐）：把 retryPolicy 直接写进 settings.yaml 的每个
 *    provider 配置里。dsh-llm-pi-ai 的 resolveRetryPolicy 会优先使用
 *    provider 级别的配置，覆盖 bundle 里的 DEFAULT。重启后即生效。
 *
 * 2. bundle 补丁（备用）：直接改 dsh-llm/lib/index.js 里内联的 4 个常量。
 *    作为 settings 注入失败时的 fallback。升级 DSH 会覆盖，需重打。
 *
 * 两条通道都改了，重启后 settings 优先级更高，不依赖 bundle 补丁。
 *
 * @module dsh-complugin/modules/retry-tuning
 */
import { defineModule } from "../core/registry.js";
import { definePatch } from "../core/hostpatch.js";
import { renderThrown } from "../core/env.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 原始 4 行常量（补丁锚点）— bundle 里 10_000 变成 1e4，0.1 变成 .1。 */
const ORIGINAL_LINES =
	"const DEFAULT_MAX_RETRIES = 5;\n"
	+ "const DEFAULT_INITIAL_DELAY_MS = 500;\n"
	+ "const DEFAULT_MAX_DELAY_MS = 1e4;\n"
	+ "const DEFAULT_JITTER_RATIO = .1;";

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
 * @param {object} cfg - 当前生效配置。
 * @returns {object} 补丁描述符。
 */
function makePatch(cfg) {
	return definePatch({
		id: "retry-tuning",
		label: "重试参数（bundle 补丁）",
		package: "@deepseek-ai/dsh-llm",
		file: "lib/index.js",
		find: ORIGINAL_LINES,
		replace: patchedLines(cfg),
		marker: PATCH_MARKER,
		note: "改 dsh-llm 打包产物里内联的重试默认常量，升级 DSH 后需要重打。"
	});
}

/**
 * 把 retryPolicy 写进 settings.yaml 的每个 provider 配置里。
 *
 * dsh-llm-pi-ai 的 resolveProfiles 会读取每个 provider 的 retryPolicy 字段，
 * 传给 resolveRetryPolicy()。如果 provider 配置了 retryPolicy，就用它；
 * 否则用 bundle 里的 DEFAULT 常量。
 *
 * settings 里的 retryPolicy 优先级 > bundle DEFAULT，所以即使 bundle 没改，
 * 只要 settings 里有 retryPolicy，重启后就会生效。
 *
 * @param {object} cfg - `{ maxRetries, initialDelayMs, maxDelayMs, jitterRatio }`.
 * @returns {{ok: boolean, detail: string, count: number}}
 */
function injectSettingsRetryPolicy(cfg) {
	try {
		const home = os.homedir();
		const settingsPath = path.join(home, ".dsh", "settings.yaml");
		if (!fs.existsSync(settingsPath)) {
			return { ok: false, detail: "找不到 settings.yaml", count: 0 };
		}
		let content = fs.readFileSync(settingsPath, "utf8");
		const lf = "\n";
		const retryLine = `retryPolicy: { mode: normal, maxRetries: ${cfg.maxRetries}, initialDelayMs: ${cfg.initialDelayMs}, maxDelayMs: ${cfg.maxDelayMs}, jitterRatio: ${cfg.jitterRatio} },`;

		/** 找到所有 provider 块的起始位置：`providerName:\n        {\n` */
		const providersIdx = content.indexOf("providers:");
		if (providersIdx < 0) return { ok: false, detail: "settings 里没有 providers 段", count: 0 };

		/** 从 providers 段开始扫描所有 `xxx:\n        {\n` 模式 */
		let count = 0;
		let modified = content;
		let scanFrom = providersIdx;
		const insertions = [];

		/** 先收集所有插入点，避免边改边搜偏移错乱 */
		while (true) {
			const lineStart = modified.indexOf(lf, scanFrom);
			if (lineStart < 0) break;
			const nextLine = modified.slice(lineStart + 1, lineStart + 200);
			/** 匹配 `          xxx:` 或 `        xxx:` 后面跟 `        {` */
			const match = nextLine.match(/^(\s+)(\w+):\s*\n(\s+)\{\s*\n/);
			if (match) {
				const providerName = match[2];
				const fullMatch = match[0];
				const insertOffset = lineStart + 1 + fullMatch.length;
				/** 检查是否已经有 retryPolicy */
				const afterInsert = modified.slice(insertOffset, insertOffset + 200);
				if (!afterInsert.includes("retryPolicy:")) {
					const indent = match[3] + "  "; // 比 `{` 的缩进多2格
					insertions.push({ offset: insertOffset, text: `${indent}${retryLine}${lf}` });
					count++;
				}
				scanFrom = insertOffset;
			} else {
				scanFrom = lineStart + 1;
			}
			/** 防止无限循环 */
			if (scanFrom >= modified.length) break;
		}

		if (insertions.length === 0) {
			/** 可能已经有 retryPolicy 了 — 尝试更新现有值 */
			const regex = /retryPolicy:\s*\{\s*mode:\s*normal,\s*maxRetries:\s*\d+,\s*initialDelayMs:\s*\d+,\s*maxDelayMs:\s*\d+,\s*jitterRatio:\s*[\d.]+\s*\}/g;
			const newLine = `retryPolicy: { mode: normal, maxRetries: ${cfg.maxRetries}, initialDelayMs: ${cfg.initialDelayMs}, maxDelayMs: ${cfg.maxDelayMs}, jitterRatio: ${cfg.jitterRatio} }`;
			const beforeCount = (modified.match(regex) || []).length;
			modified = modified.replace(regex, newLine);
			count = beforeCount;
			if (count > 0) {
				fs.writeFileSync(settingsPath, modified, "utf8");
				return { ok: true, detail: `已更新 ${count} 个 provider 的 retryPolicy`, count };
			}
			return { ok: false, detail: "没找到 provider 块也无法更新", count: 0 };
		}

		/** 从后往前插入，避免偏移错乱 */
		insertions.sort((a, b) => b.offset - a.offset);
		for (const ins of insertions) {
			modified = modified.slice(0, ins.offset) + ins.text + modified.slice(ins.offset);
		}

		fs.writeFileSync(settingsPath, modified, "utf8");
		return { ok: true, detail: `已为 ${count} 个 provider 注入 retryPolicy`, count };
	} catch (error) {
		return { ok: false, detail: `settings 注入失败：${renderThrown(error)}`, count: 0 };
	}
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

/**
 * 对用户配置做兜底校正。
 * @param {object} raw - 原始配置。
 * @returns {{maxRetries: number, initialDelayMs: number, maxDelayMs: number, jitterRatio: number, clamped: boolean}}
 */
function safeConfig(raw) {
	const maxRetries = Number.isSafeInteger(raw?.maxRetries) && raw.maxRetries >= 0 ? raw.maxRetries : 5;
	const initialDelayMs = Number.isFinite(raw?.initialDelayMs) && raw.initialDelayMs > 0 ? raw.initialDelayMs : 500;
	let maxDelayMs = Number.isFinite(raw?.maxDelayMs) && raw.maxDelayMs > 0 ? raw.maxDelayMs : 10000;
	const jitterRatio = Number.isFinite(raw?.jitterRatio) && raw.jitterRatio >= 0 && raw.jitterRatio <= 1 ? raw.jitterRatio : 0.1;
	let clamped = false;
	if (maxDelayMs < initialDelayMs) {
		maxDelayMs = initialDelayMs;
		clamped = true;
	}
	return { maxRetries, initialDelayMs, maxDelayMs, jitterRatio, clamped };
}

/** Module declaration. */
export default defineModule({
	id: "retryTuning",
	kind: "patch",
	order: 35,
	title: "重试调整",
	summary: "调节模型请求的重试次数与退避延迟，减少重试对上下文的污染。",
	legacy: "",
	docs: "双通道：① 把 retryPolicy 写进 settings.yaml 的 provider 配置（推荐，重启后生效）；② bundle 补丁作为 fallback。重启 DSH 后生效。",
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
		{ id: "recheck", label: "重新检测", desc: "重新检查补丁状态与当前生效值", tone: "ghost" },
		{ id: "applySettings", label: "注入 Settings", desc: "把 retryPolicy 写进 settings.yaml 的 provider 配置（重启后生效）", tone: "primary" }
	],
	patch: makePatch({ maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }),
	patchFactory: (cfg) => makePatch(safeConfig(cfg)),
	mount({ ctx, env, logger, config }) {
		const patcher = env.patch;
		let state = { ok: false, detail: "尚未检测" };
		let settingsState = { ok: false, detail: "未注入" };
		let disposed = false;

		/** 用当前配置重新生成补丁描述符并检测状态。 */
		const checkState = async () => {
			const safe = safeConfig(config());
			const patch = makePatch(safe);
			try {
				const status = await patcher.status(patch);
				const live = readLivePolicy(ctx);
				const liveStr = live === null ? "未知" : `${live.maxRetries} 次 / ${live.initialDelayMs}ms / 上限 ${live.maxDelayMs}ms`;
				const clampNote = safe.clamped ? "（最大延迟已兜底为首次延迟）" : "";
				if (status.state === "applied") {
					state = { ok: true, detail: `补丁在位（当前生效：${liveStr}）${clampNote}` };
				} else if (status.state === "clean") {
					state = { ok: true, detail: `未打补丁（当前生效：${liveStr}）${clampNote}` };
				} else if (status.state === "missing") {
					state = { ok: false, detail: `找不到目标文件：${status.detail}` };
				} else {
					state = { ok: false, detail: status.detail };
				}
				/** 检测是否需要重启 */
				const needsRestart = live !== null && live.maxRetries !== safe.maxRetries;
				if (needsRestart) {
					state.detail += ` · 配置=${safe.maxRetries}，生效=${live.maxRetries}，需重启 DSH 生效`;
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
				const safe = safeConfig(config());
				const live = readLivePolicy(ctx);
				const configured = `${safe.maxRetries} 次 / ${safe.initialDelayMs}ms / 上限 ${safe.maxDelayMs}ms`;
				const liveStr = live === null ? "未知" : `${live.maxRetries} 次 / ${live.initialDelayMs}ms`;
				const patchApplied = state.detail.startsWith("补丁在位");
				const needsRestart = live !== null && live.maxRetries !== safe.maxRetries;
				const entries = [{ level: state.ok ? "info" : "warn", text: state.detail, at: 0 }];
				if (safe.clamped) {
					entries.push({ level: "warn", text: "最大延迟 < 首次延迟，已自动兜底为首次延迟，避免 DSH 启动报错", at: 0 });
				}
				if (needsRestart) {
					entries.push({ level: "warn", text: `配置=${safe.maxRetries} 但生效=${live?.maxRetries}，需要重启 DSH 让新值生效`, at: 0 });
				}
				return {
					ready: true,
					sign: patchApplied ? "on" : "idle",
					badge: patchApplied ? "已调整" : "默认值",
					line: `配置：${configured} · 生效：${liveStr}${needsRestart ? " · 需重启" : ""}`,
					entries,
					stats: [
						{ label: "配置次数", value: safe.maxRetries },
						{ label: "生效次数", value: live?.maxRetries ?? "?" }
					]
				};
			},
			actions: {
				recheck: async () => {
					await checkState();
					return { ok: state.ok, detail: state.detail };
				},
				applySettings: async () => {
					const safe = safeConfig(config());
					const result = injectSettingsRetryPolicy(safe);
					settingsState = result;
					await checkState();
					return { ok: result.ok, detail: `${result.detail}。重启 DSH 后生效。` };
				}
			}
		};
	}
});
