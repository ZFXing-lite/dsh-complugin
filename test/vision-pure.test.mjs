/**
 * Unit tests for the pure half of dsh-vision-bridge.
 *
 * The host half needs a live cordis context and the browser card needs a DOM,
 * so everything decision-shaped lives in `lib/pure.js` and is tested here
 * without either: the presence rule, the image walk, the prompt/replacement
 * text, and the provider-response parser.
 *
 * Run: node --test test/
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULTS,
	DEFAULT_PROMPT,
	buildPrompt,
	clampTokensFromError,
	contentHasImage,
	extractAssistantText,
	finishReasonOf,
	flattenText,
	focusOf,
	formatDescription,
	formatFailure,
	hash32,
	messagesHaveImage,
	normalizeBaseURL,
	normalizeConfig,
	readinessOf,
	replaceImagesDeep,
	resolveKey,
	transcriptionKey
} from "../lib/core/vision.js";

const attachment = Object.freeze({
	attachmentId: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	mediaType: "image/png",
	bytes: 4096,
	width: 1280,
	height: 720
});

test("DEFAULTS is frozen and mode defaults to auto", () => {
	assert.equal(Object.isFrozen(DEFAULTS), true);
	assert.equal(DEFAULTS.mode, "auto");
	assert.equal(normalizeConfig({}).mode, "auto");
});

test("normalizeBaseURL adds a scheme and strips trailing slashes", () => {
	assert.equal(normalizeBaseURL("api.openai.com/v1/"), "https://api.openai.com/v1");
	assert.equal(normalizeBaseURL("  http://127.0.0.1:11434/v1//  "), "http://127.0.0.1:11434/v1");
	assert.equal(normalizeBaseURL(""), "");
	assert.equal(normalizeBaseURL(undefined), "");
});

test("normalizeConfig clamps numbers and rejects an unknown mode", () => {
	const config = normalizeConfig({ mode: "sometimes", maxTokens: 999_999, timeoutMs: 1, baseURL: "x.test/v1" });
	assert.equal(config.mode, "auto");
	assert.equal(config.maxTokens, 16_384);
	assert.equal(config.timeoutMs, 5_000);
	assert.equal(config.baseURL, "https://x.test/v1");
	assert.equal(Object.isFrozen(config), true);
});

test("readiness: missing endpoint, model or key keeps the plugin off", () => {
	const blank = readinessOf(normalizeConfig({}), "");
	assert.equal(blank.active, false);
	assert.deepEqual(blank.missing, ["baseURL", "model", "apiKey"]);

	const half = readinessOf(normalizeConfig({ baseURL: "https://a.test/v1", model: "vlm" }), "");
	assert.equal(half.active, false);
	assert.deepEqual(half.missing, ["apiKey"]);
	assert.equal(half.keySource, "none");

	const armed = readinessOf(normalizeConfig({ baseURL: "https://a.test/v1", model: "vlm" }), "sk-live");
	assert.equal(armed.active, true);
	assert.deepEqual(armed.missing, []);
	assert.equal(armed.keySource, "credentials");

	const inline = readinessOf(normalizeConfig({ baseURL: "https://a.test/v1", model: "vlm", apiKey: "your_api_key" }), "");
	assert.equal(inline.active, true);
	assert.equal(inline.keySource, "settings");
});

test("credential beats the inline key; mode off overrides a complete config", () => {
	const config = normalizeConfig({ baseURL: "https://a.test/v1", model: "vlm", apiKey: "your_api_key" });
	assert.equal(resolveKey(config, "stored_test_key"), "stored_test_key");
	assert.equal(resolveKey(config, ""), "your_api_key");
	assert.equal(readinessOf({ ...config, mode: "off" }, "stored_test_key").active, false);
});

test("contentHasImage finds images nested in tool results", () => {
	const nested = [{ type: "tool-result", content: [{ type: "text", text: "shot" }, { type: "image", attachment }] }];
	assert.equal(contentHasImage(nested), true);
	assert.equal(messagesHaveImage([{ role: "user", content: nested }]), true);
	assert.equal(messagesHaveImage([{ role: "user", content: [{ type: "text", text: "hi" }] }]), false);
	assert.equal(messagesHaveImage(undefined), false);
});

test("replaceImagesDeep swaps images, keeps identity when nothing changed", async () => {
	const plain = [{ type: "text", text: "no picture" }];
	const untouched = await replaceImagesDeep(plain, async () => "nope");
	assert.equal(untouched.changed, false);
	assert.equal(untouched.content, plain);
	assert.equal(untouched.count, 0);

	const mixed = [
		{ type: "text", text: "before" },
		{ type: "image", attachment },
		{ type: "tool-result", content: [{ type: "image", attachment }] }
	];
	const seen = [];
	const result = await replaceImagesDeep(mixed, async (ref) => {
		seen.push(ref.attachmentId);
		return `described:${ref.attachmentId.slice(7, 13)}`;
	});
	assert.equal(result.changed, true);
	assert.equal(result.count, 2);
	assert.deepEqual(seen, [attachment.attachmentId, attachment.attachmentId]);
	assert.deepEqual(result.content[1], { type: "text", text: "described:012345" });
	assert.equal(result.content[2].type, "tool-result");
	assert.deepEqual(result.content[2].content, [{ type: "text", text: "described:012345" }]);
	assert.equal(result.content[0], mixed[0]);
	assert.equal(mixed.length, 3);
});

test("focusOf takes the last non-empty user text and truncates", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "old question" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		{ role: "user", content: [{ type: "text", text: "报错在哪一行？" }, { type: "image", attachment }] }
	];
	assert.equal(focusOf(messages), "报错在哪一行？");
	assert.equal(focusOf([{ role: "assistant", content: [] }]), "");
	assert.equal(flattenText(messages[0]), "old question");
	assert.equal(focusOf([{ role: "user", content: [{ type: "text", text: "x".repeat(900) }] }]).length, 701);
});

test("buildPrompt uses the built-in prompt unless overridden, then appends focus", () => {
	assert.equal(buildPrompt("", ""), DEFAULT_PROMPT);
	assert.equal(buildPrompt("   ", "查找错误"), `${DEFAULT_PROMPT}\n\n【当前用户的问题，仅用于确定转述重点，不要回答它】\n查找错误`);
	assert.equal(buildPrompt("自定义提示", ""), "自定义提示");
	assert.match(DEFAULT_PROMPT, /OCR/u);
});

test("extractAssistantText accepts string, parts and legacy text responses", () => {
	assert.equal(extractAssistantText({ choices: [{ message: { content: "红色" } }] }), "红色");
	assert.equal(extractAssistantText({ choices: [{ message: { content: [{ type: "text", text: "红色" }, { type: "text", text: "。方形" }] } }] }), "红色\n。方形");
	assert.equal(extractAssistantText({ choices: [{ text: "蓝色" }] }), "蓝色");
	assert.throws(() => extractAssistantText({ choices: [{ message: { content: "   " } }] }), /空内容/u);
	assert.throws(() => extractAssistantText({}), /空内容/u);
});

test("replacement text names the transcription, the model and the size", () => {
	const described = formatDescription("图里是一段终端输出", { attachment, model: "gpt-4o-mini" });
	assert.match(described, /原图未传给当前模型/u);
	assert.match(described, /sha256:0123456789ab/u);
	assert.match(described, /1280x720/u);
	assert.match(described, /gpt-4o-mini/u);
	assert.match(described, /图里是一段终端输出/u);

	const failed = formatFailure("HTTP 401 invalid api key", { attachment, model: "gpt-4o-mini" });
	assert.match(failed, /转述失败/u);
	assert.match(failed, /HTTP 401/u);
	assert.doesNotMatch(failed, /图里/u);
});

test("transcriptionKey changes with model and prompt, not with the ref alone", () => {
	const base = transcriptionKey(attachment, "vlm-a", "prompt-1");
	assert.equal(base, transcriptionKey(attachment, "vlm-a", "prompt-1"));
	assert.notEqual(base, transcriptionKey(attachment, "vlm-b", "prompt-1"));
	assert.notEqual(base, transcriptionKey(attachment, "vlm-a", "prompt-2"));
	assert.equal(hash32("prompt-1"), hash32("prompt-1"));
	assert.notEqual(hash32("prompt-1"), hash32("prompt-2"));
});

test("clampTokensFromError reads the provider's own budget range", () => {
	// The rejection 智谱 actually returns for glm-4v-flash.
	const zhipu = 'HTTP 400 {"error":{"code":"1210","message":"max_tokens参数非法：限制数值范围[1,1024]"}}';
	assert.equal(clampTokensFromError(zhipu, 1200), 1024);
	assert.equal(clampTokensFromError(zhipu, 4000), 1024);
	assert.equal(clampTokensFromError(zhipu, 1024), undefined, "already inside the range — no retry");
	assert.equal(clampTokensFromError(zhipu, 64), undefined);

	// A range that is tighter at the bottom.
	assert.equal(clampTokensFromError("max_tokens must be in [256, 8192]", 100), 256);
	// No numbers, but clearly an over-large budget.
	assert.equal(clampTokensFromError("max_tokens too large for this model", 4096), 2048);
	assert.equal(clampTokensFromError("max_completion_tokens 超出上限", 1000), 500);
	assert.equal(clampTokensFromError("max_tokens too large", 64), undefined, "floor stays put");
	// Unrelated errors must not be mistaken for a budget complaint.
	assert.equal(clampTokensFromError("model not found", 1200), undefined);
	assert.equal(clampTokensFromError("", 1200), undefined);
	assert.equal(clampTokensFromError(undefined, 1200), undefined);
});

test("finishReasonOf only reports what the provider actually said", () => {
	assert.equal(finishReasonOf({ choices: [{ finish_reason: "length" }] }), "length");
	assert.equal(finishReasonOf({ choices: [{ finish_reason: "STOP" }] }), "stop");
	assert.equal(finishReasonOf({ choices: [{ finishReason: "length" }] }), "length");
	assert.equal(finishReasonOf({ choices: [{}] }), "");
	assert.equal(finishReasonOf({}), "");
	assert.equal(finishReasonOf(undefined), "");
});
