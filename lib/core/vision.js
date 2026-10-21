/**
 * dsh-vision-bridge — pure helpers.
 *
 * Everything here is side-effect free and import-free (no `node:` builtins, no
 * DSH packages) so the browser card, the host half and the unit tests can all
 * depend on the same rules. The host keeps only I/O: settings, HTTP, cache.
 *
 * @module dsh-vision-bridge/pure
 */

/** Accepted `mode` values, in precedence order. */
export const MODES = Object.freeze(["auto", "always", "off"]);

/** Settings defaults; the loader row's `config` layers over these. */
export const DEFAULTS = Object.freeze({
	mode: "auto",
	baseURL: "",
	model: "",
	apiKey: "",
	prompt: "",
	// 1024 is the highest budget the common Chinese vision endpoints accept
	// (智谱 glm-4v-flash/plus answer `max_tokens参数非法：限制数值范围[1,1024]`
	// above it). Raising this is fine: the host clamps itself back into whatever
	// range a provider reports.
	maxTokens: 1024,
	timeoutMs: 60_000,
	focusFromUserText: true,
	includeSubagents: true,
	cacheEnabled: true
});

/**
 * Built-in transcription prompt.
 *
 * The audience is a text-only model that will never see the picture: what it
 * cannot read, it cannot reason about. So the instruction asks for lossless
 * OCR, structure, and numbers — and forces explicit uncertainty instead of
 * fluent guesses.
 */
export const DEFAULT_PROMPT = [
	"你是一个精确的图像转述器。请把这张图片转述成给「看不见这张图的文本模型」阅读的完整说明。",
	"",
	"要求：",
	"1. 逐字抄录图中所有可见文字（OCR）：标题、按钮、菜单、报错、提示、文件名、时间戳、水印。文字模糊时标注「（模糊）」并给出最可能的读法，不要跳过。",
	"2. 说明图片类型与整体布局：截图 / 照片 / 文档 / 图表 / 表格 / 代码 / 终端 / UI 界面，各区域的位置与层级关系。",
	"3. 图表：写出坐标轴、单位、图例、关键数据点与数值、趋势结论。表格：按行列给出单元格内容，行列表头不要省略。",
	"4. 代码、终端、日志：完整抄录代码 / 命令 / 输出，保留缩进与符号，不要概括。",
	"5. 界面截图：列出可见控件、当前状态、选中项、报错与提示，并说明用户此刻大概在做什么操作。",
	"6. 照片、人物：客观描述主体、动作、场景、显著物体与主要颜色；不评价美丑。",
	"7. 严格区分「确定看到」与「推测」：推测必须标注（推测）。看不清就说看不清，不要编。",
	"8. 用中文输出；专有名词、代码、路径、URL、标识符保留原文。",
	"",
	"直接输出转述正文，不要寒暄，不要描述你的转述过程。"
].join("\n");

/** Render any thrown value as a log-safe message. */
export function renderThrown(value) {
	if (value instanceof Error) return value.message;
	return String(value);
}

/**
 * Canonicalize an endpoint root: add a scheme when missing, drop trailing slashes.
 * @param {unknown} input - raw user text.
 * @returns {string} the canonical root, or "" when unset.
 */
export function normalizeBaseURL(input) {
	let text = String(input ?? "").trim();
	if (text === "") return "";
	if (!/^https?:\/\//iu.test(text)) text = `https://${text}`;
	return text.replace(/\/+$/u, "");
}

/** Clamp one integer setting into range, falling back on garbage. */
function integer(value, fallback, min, max) {
	const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Coerce a raw settings document into the live shape the engine uses.
 * Never throws: a hand-edited settings.yaml with nonsense degrades to defaults.
 * @param {object} raw - effective settings value (defaults applied by schemastery).
 * @returns {object} frozen normalized config.
 */
export function normalizeConfig(raw) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	const mode = MODES.includes(source.mode) ? source.mode : DEFAULTS.mode;
	return Object.freeze({
		mode,
		baseURL: normalizeBaseURL(source.baseURL),
		model: String(source.model ?? "").trim(),
		apiKey: String(source.apiKey ?? "").trim(),
		prompt: String(source.prompt ?? ""),
		maxTokens: integer(source.maxTokens, DEFAULTS.maxTokens, 64, 16_384),
		timeoutMs: integer(source.timeoutMs, DEFAULTS.timeoutMs, 5_000, 300_000),
		focusFromUserText: source.focusFromUserText !== false,
		includeSubagents: source.includeSubagents !== false,
		cacheEnabled: source.cacheEnabled !== false
	});
}

/**
 * The key actually used for the vision call: the credential store wins, the
 * inline settings field is the fallback.
 * @param {object} config - normalized config.
 * @param {string} credentialValue - resolved VISION_BRIDGE_API_KEY, "" when absent.
 * @returns {string} the key, or "" when nothing is configured.
 */
export function resolveKey(config, credentialValue) {
	const stored = String(credentialValue ?? "").trim();
	if (stored !== "") return stored;
	return String(config?.apiKey ?? "").trim();
}

/**
 * Presence-driven activation: no endpoint, no model or no key means the plugin
 * is off; filling all three turns it on. `mode: "off"` overrides that.
 * @param {object} config - normalized config.
 * @param {string} credentialValue - resolved credential, "" when absent.
 * @returns {{active: boolean, missing: string[], baseURL: string, model: string, key: string, keySource: "credentials"|"settings"|"none"}} readiness.
 */
export function readinessOf(config, credentialValue) {
	const key = resolveKey(config, credentialValue);
	const missing = [];
	if (config.baseURL === "") missing.push("baseURL");
	if (config.model === "") missing.push("model");
	if (key === "") missing.push("apiKey");
	const keySource = String(credentialValue ?? "").trim() !== "" ? "credentials" : config.apiKey !== "" ? "settings" : "none";
	return {
		active: missing.length === 0 && config.mode !== "off",
		missing,
		baseURL: config.baseURL,
		model: config.model,
		key,
		keySource
	};
}

/**
 * Whether one content block list carries an image, including images nested
 * inside tool results (a read_image result, a screenshot tool, a browser grab).
 * @param {unknown} content - a message's content blocks.
 * @returns {boolean} true when an image block exists anywhere in the tree.
 */
export function contentHasImage(content) {
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		if (block.type === "image") return true;
		if (Array.isArray(block.content) && contentHasImage(block.content)) return true;
	}
	return false;
}

/**
 * Whether any message in the request carries an image.
 * @param {unknown} messages - request messages.
 * @returns {boolean} true when at least one image block is present.
 */
export function messagesHaveImage(messages) {
	if (!Array.isArray(messages)) return false;
	for (const message of messages) {
		if (message !== null && typeof message === "object" && contentHasImage(message.content)) return true;
	}
	return false;
}

/**
 * Walk a content tree and substitute every image block with the text produced
 * by `describe`. Immutable: untouched branches keep their original identity, so
 * a request with no image is returned unchanged (same reference) and the caller
 * can cheaply skip a re-dispatch.
 *
 * @param {unknown} content - content blocks to transform.
 * @param {(attachment: object) => Promise<string>} describe - async renderer for one image ref.
 * @returns {Promise<{content: unknown, changed: boolean, count: number}>} transformed blocks.
 */
export async function replaceImagesDeep(content, describe) {
	if (!Array.isArray(content)) return { content, changed: false, count: 0 };
	const out = [];
	let changed = false;
	let count = 0;
	for (const block of content) {
		if (block === null || typeof block !== "object") {
			out.push(block);
			continue;
		}
		if (block.type === "image" && block.attachment !== null && typeof block.attachment === "object") {
			count += 1;
			const text = await describe(block.attachment);
			out.push({ type: "text", text: String(text ?? "") });
			changed = true;
			continue;
		}
		if (Array.isArray(block.content)) {
			const nested = await replaceImagesDeep(block.content, describe);
			count += nested.count;
			if (nested.changed) {
				out.push({ ...block, content: nested.content });
				changed = true;
				continue;
			}
		}
		out.push(block);
	}
	return { content: changed ? out : content, changed, count };
}

/** Join the text blocks of one message. */
export function flattenText(message) {
	if (message === null || typeof message !== "object" || !Array.isArray(message.content)) return "";
	const parts = [];
	for (const block of message.content) {
		if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * The last user text, used as a focus hint so the transcription spends its
 * budget on what the conversation actually needs.
 * @param {unknown} messages - request messages.
 * @param {number} limit - maximum characters kept.
 * @returns {string} the trimmed focus text ("" when there is none).
 */
export function focusOf(messages, limit = 700) {
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === null || typeof message !== "object" || message.role !== "user") continue;
		const text = flattenText(message).trim();
		if (text === "") continue;
		return text.length > limit ? `${text.slice(0, limit)}…` : text;
	}
	return "";
}

/**
 * Compose the prompt sent to the vision model.
 * @param {string} custom - user override; blank means the built-in prompt.
 * @param {string} focus - current user question, "" when unused.
 * @returns {string} the final prompt text.
 */
export function buildPrompt(custom, focus) {
	const base = String(custom ?? "").trim() === "" ? DEFAULT_PROMPT : String(custom).trim();
	const hint = String(focus ?? "").trim();
	if (hint === "") return base;
	return `${base}\n\n【当前用户的问题，仅用于确定转述重点，不要回答它】\n${hint}`;
}

/**
 * Extract assistant text from an OpenAI-compatible chat completion, tolerating
 * providers that answer with a string, an array of parts, or `choices[].text`.
 * @param {unknown} payload - parsed response JSON.
 * @returns {string} non-empty text.
 * @throws when the payload carries no usable text.
 */
export function extractAssistantText(payload) {
	const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
	const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text;
	const parts = [];
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const part of content) {
			if (typeof part === "string") parts.push(part);
			else if (part !== null && typeof part === "object" && typeof part.text === "string") parts.push(part.text);
		}
	}
	const text = parts.join("\n").trim();
	if (text === "") throw new Error("视觉模型返回了空内容");
	return text;
}

/**
 * The provider's stop reason for the first choice: `"stop"`, `"length"`, …
 * `"length"` is the signal that the text was cut off at the token cap.
 * @param {unknown} payload - parsed response JSON.
 * @returns {string} lowercase reason, "" when the provider omits it.
 */
export function finishReasonOf(payload) {
	const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
	const reason = choice?.finish_reason ?? choice?.finishReason;
	return typeof reason === "string" ? reason.toLowerCase() : "";
}

/** Short readable handle for an attachment ref. */
export function shortRef(attachment) {
	const id = String(attachment?.attachmentId ?? "");
	const digest = id.replace(/^sha256:/u, "");
	return digest === "" ? "（无摘要）" : digest.slice(0, 12);
}

/** `1024x768` when the ref carries dimensions, "" otherwise. */
export function dimensionsOf(attachment) {
	const width = Number(attachment?.width);
	const height = Number(attachment?.height);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return "";
	return `${width}x${height}`;
}

/**
 * Render the stand-in text for one described image. The wording is deliberate:
 * the main model must understand that the pixels are gone and that the text is
 * a transcription, not a caption it may summarise away.
 * @param {string} text - the vision model's transcription.
 * @param {{attachment: object, model: string}} context - source ref and vision model.
 * @returns {string} the replacement text block body.
 */
export function formatDescription(text, context) {
	const dims = dimensionsOf(context?.attachment);
	const size = dims === "" ? "" : ` ${dims}`;
	return [
		`[vision-bridge 视觉桥] 原图未传给当前模型；图片 sha256:${shortRef(context?.attachment)}${size} 已由视觉模型 ${context?.model ?? "未知"} 转述为以下文字，请据此回答：`,
		String(text ?? "").trim()
	].join("\n");
}

/**
 * Render the stand-in text for one image the bridge could not transcribe.
 * A turn must never die on a vision failure: the model gets an explicit gap.
 * @param {string} reason - the failure message.
 * @param {{attachment: object, model: string}} context - source ref and vision model.
 * @returns {string} the replacement text block body.
 */
export function formatFailure(reason, context) {
	const dims = dimensionsOf(context?.attachment);
	const size = dims === "" ? "" : ` ${dims}`;
	return `[vision-bridge 视觉桥] 图片 sha256:${shortRef(context?.attachment)}${size} 转述失败（${reason}），本图内容缺失。如需图片内容，请重试或更换视觉模型。`;
}

/** FNV-1a 32-bit, hex — cache key material for prompts, not a security hash. */
export function hash32(text) {
	let hash = 0x811c9dc5;
	const source = String(text ?? "");
	for (let index = 0; index < source.length; index += 1) {
		hash ^= source.charCodeAt(index) & 0xff;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${hash.toString(16).padStart(8, "0")}-${source.length.toString(16)}`;
}

/**
 * Cache key for one transcription: same bytes, same model, same prompt answer
 * identically, so the key is exactly that tuple.
 * @param {object} attachment - image ref.
 * @param {string} model - vision model id.
 * @param {string} prompt - final prompt text.
 * @returns {string} cache key.
 */
export function transcriptionKey(attachment, model, prompt) {
	return `${String(attachment?.attachmentId ?? "")}\u0000${model}\u0000${hash32(prompt)}`;
}

/**
 * Read the output-token budget a provider is willing to accept out of its own
 * rejection message.
 *
 * Vision endpoints disagree wildly about the cap — `glm-4v-flash` answers
 * `max_tokens参数非法：限制数值范围[1,1024]`, others say "too large" with no
 * numbers. Rather than making the user guess, the host asks once more with the
 * budget the provider just described.
 *
 * @param {string} message - the provider's error body.
 * @param {number} current - the budget that was rejected.
 * @returns {number|undefined} a new budget, or undefined when nothing is readable.
 */
export function clampTokensFromError(message, current) {
	const text = String(message ?? "");
	if (text === "" || !/max_tokens|max_completion_tokens/iu.test(text)) return undefined;
	const budget = Number.isFinite(current) ? Math.trunc(current) : DEFAULTS.maxTokens;
	const range = text.match(/\[\s*(\d{1,7})\s*,\s*(\d{1,7})\s*\]/u);
	if (range !== null) {
		const min = Number(range[1]);
		const max = Number(range[2]);
		if (Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max >= min) {
			const clamped = Math.min(max, Math.max(min, budget));
			return clamped === budget ? undefined : clamped;
		}
	}
	if (/过大|太大|超出|越界|exceed|too large|too big|upper bound|maximum/iu.test(text)) {
		const halved = Math.max(64, Math.floor(budget / 2));
		return halved === budget ? undefined : halved;
	}
	return undefined;
}

/** Truncate a response body for an error message. */
export function snippet(text, limit = 240) {
	const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
