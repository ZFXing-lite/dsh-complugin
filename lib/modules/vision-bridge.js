/**
 * dsh-vision-bridge — host half.
 *
 * ── What this buys ────────────────────────────────────────────────────────
 *
 * DSH decides whether a picture may enter a conversation from the routed
 * model's declared input modalities. A text-only route therefore refuses an
 * attached image at the prompt gate, and `read_image` refuses to read one.
 * This plugin makes every route accept images, then supplies the missing
 * eyesight itself:
 *
 *   1. ADMISSION. `LlmRuntime.prototype.resolveModelInfo` is wrapped so the
 *      declared modality list of a non-vision route also reports `image`.
 *      That is the exact predicate every admission gate consults
 *      (`api-session-controller`, `tool-fs` `read_image`, `acp`, `subagent`),
 *      so images are admitted everywhere. The wrap is a no-op until the panel
 *      is configured, and it never lies to the ADAPTER — `prepareCall` and
 *      `adapterStream` keep the real capability, so an untranscribed image
 *      still degrades to DSH's own placeholder instead of a provider error.
 *
 *   2. SIGHT. The `llm/stream` waterfall sees the complete outgoing request
 *      before any provider call. If the routed model genuinely declares
 *      `image` input, the request is passed through untouched — native vision
 *      wins. Otherwise every image block is transcribed by the configured
 *      vision model (OpenAI-compatible `/chat/completions`, one call per
 *      image, cached by attachment digest + model + prompt) and swapped for a
 *      text block that says plainly: the pixels are not here, this is their
 *      transcription.
 *
 * Waterfall semantics force the shape: a `llm/stream` listener cannot replace
 * `options` for downstream listeners (they share one args array), so the
 * bridged request is re-dispatched through `ctx.llm.stream` behind a WeakSet
 * marker. Re-entry loses the loop's `prepared` call — which only carries replay
 * headers — and re-resolves the adapter from the provider/model instead.
 *
 * Nothing durable is rewritten: session history keeps its image blocks, so
 * switching to a multimodal model later restores native vision on the same
 * session.
 *
 * @module dsh-vision-bridge
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import {
	DEFAULTS,
	DEFAULT_PROMPT,
	MODES,
	buildPrompt,
	clampTokensFromError,
	extractAssistantText,
	finishReasonOf,
	formatDescription,
	formatFailure,
	focusOf,
	messagesHaveImage,
	normalizeBaseURL,
	normalizeConfig,
	readinessOf,
	renderThrown,
	replaceImagesDeep,
	snippet,
	transcriptionKey
} from "../core/vision.js";
import { defineModule } from "../core/registry.js";

/** Cordis plugin name (must match the loader row id in cordis.patch.yml). */
const name = "vision-bridge";

/** Hard requirements: a settings surface and the LLM runtime to bridge. */
const inject = ["settings", "llm"];

/** Settings namespace this plugin owns; also the browser card's slot key. */
const NAMESPACE = "vision-bridge";

/** Credential ref holding the vision key (wins over the inline settings field). */
const CREDENTIAL_REF = "VISION_BRIDGE_API_KEY";

/** Persisted transcription cache beside the rest of the DSH home state. */
const CACHE_FILE = "vision-bridge-cache.json";

/** Marks a patched `resolveModelInfo`; the record is shared across reloads. */
const PATCH_MARK = Symbol.for("dsh-vision-bridge/resolveModelInfo");

/** How long a forced modality override is served from memory. */
const FORCED_TTL_MS = 15_000;

/** A transcription is reused for this long. */
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Cache entry cap; oldest entries are dropped first. */
const CACHE_MAX_ENTRIES = 400;

/** Request-image budget for the vision call: model-request size, not raw bytes. */
const REQUEST_IMAGE_POLICY = Object.freeze({ maxPixels: 4_194_304, maxBytes: 1_048_576 });

/** 24x24 solid red PNG — the smoke-test payload behind the panel's 测试 button. */
const TEST_IMAGE_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGO4o6ZGFcQwatCoQaMGjRo0atCoQQNvEAAd/5ofEnN82gAAAABJRU5ErkJggg==";

/** Field name for the endpoint credential, shared by the schema and the request builders. */
const API_KEY = "apiKey";

/** Settings schema for the `vision-bridge` namespace (also validates row config). */
const SettingsSchema = z.object({
	mode: z.string().default(DEFAULTS.mode),
	baseURL: z.string().default(DEFAULTS.baseURL),
	model: z.string().default(DEFAULTS.model),
	[API_KEY]: z.string().default(DEFAULTS.apiKey),
	prompt: z.string().default(DEFAULTS.prompt),
	maxTokens: z.natural().min(64).max(16_384).default(DEFAULTS.maxTokens),
	timeoutMs: z.natural().min(5_000).max(300_000).default(DEFAULTS.timeoutMs),
	focusFromUserText: z.boolean().default(DEFAULTS.focusFromUserText),
	includeSubagents: z.boolean().default(DEFAULTS.includeSubagents),
	cacheEnabled: z.boolean().default(DEFAULTS.cacheEnabled)
});

/** Resolve `$DSH_HOME` the way the rest of the harness does. */
function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	return path.join(os.homedir(), ".dsh");
}

/** `fetch` with a hard timeout, so one dead endpoint cannot hang a turn. */
async function fetchWithTimeout(url, init, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
	timer.unref?.();
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** Build an OpenAI-compatible chat-completion body for one image. */
function visionBody(request, tokensField) {
	return JSON.stringify({
		model: request.model,
		messages: [{
			role: "user",
			content: [
				{ type: "text", text: request.prompt },
				{ type: "image_url", image_url: { url: request.dataURL } }
			]
		}],
		[tokensField]: request.maxTokens,
		temperature: 0.2,
		stream: false
	});
}

/**
 * Body for a continuation round: the same image and prompt, plus what the model
 * already wrote, so it can pick up at the cut instead of starting over.
 * @param {object} request - the original vision request.
 * @param {string} tokensField - `max_tokens` or `max_completion_tokens`.
 * @param {number} tokens - output budget.
 * @param {string} soFar - text produced by the previous round.
 * @returns {string} JSON body.
 */
function continuationBody(request, tokensField, tokens, soFar) {
	return JSON.stringify({
		model: request.model,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: request.prompt },
					{ type: "image_url", image_url: { url: request.dataURL } }
				]
			},
			{ role: "assistant", content: soFar },
			{
				role: "user",
				content: "上一条回答因长度限制被截断了。请从中断处继续写，接着补完剩余的转录内容，不要重复已经写过的部分。"
			}
		],
		[tokensField]: tokens,
		temperature: 0.2,
		stream: false
	});
}

/**
 * One OpenAI-compatible vision call.
 *
 * Handles the three things vision endpoints disagree about: the token-budget
 * field name, the token-budget cap (many Chinese endpoints stop at 1024), and
 * truncation — a dense screenshot outgrows a small cap, so a `finish_reason:
 * "length"` answer is continued rather than silently cut in half.
 *
 * @param {object} request - endpoint, key, model, prompt and data URL.
 * @returns {Promise<string>} the transcription.
 */
async function callVision(request) {
	const headers = {
		"content-type": "application/json",
		...(request.apiKey === "" ? {} : { authorization: `Bearer ${request.apiKey}` })
	};
	const url = `${normalizeBaseURL(request.baseURL)}/chat/completions`;
	let tokensField = "max_tokens";
	let budget = request.maxTokens;
	/** Send one attempt with the current field/budget pair. */
	const send = async () => {
		const response = await fetchWithTimeout(
			url,
			{ method: "POST", headers, body: visionBody({ ...request, maxTokens: budget }, tokensField) },
			request.timeoutMs
		);
		return { response, body: await response.text() };
	};

	let attempt = await send();
	// Newer OpenAI-style routes reject `max_tokens` in favour of the completion
	// spelling; retry with it rather than failing the whole image.
	if (!attempt.response.ok && attempt.response.status === 400 && /max_completion_tokens/u.test(attempt.body)) {
		tokensField = "max_completion_tokens";
		attempt = await send();
	}
	// Providers cap the output budget and say so in the rejection. Honour the
	// range they just described instead of handing the user a dead image.
	for (let retries = 0; retries < 2 && !attempt.response.ok && attempt.response.status === 400; retries += 1) {
		const clamped = clampTokensFromError(attempt.body, budget);
		if (clamped === undefined) break;
		request.note?.(`vision-bridge: 端点只接受 ${clamped} 输出 tokens，已自动夹取（原值 ${budget}）`);
		budget = clamped;
		attempt = await send();
	}

	if (!attempt.response.ok) throw new Error(`HTTP ${attempt.response.status} ${snippet(attempt.body)}`);
	let payload;
	try {
		payload = JSON.parse(attempt.body);
	} catch {
		throw new Error(`返回不是 JSON：${snippet(attempt.body)}`);
	}
	let output = extractAssistantText(payload);
	let reason = finishReasonOf(payload);

	// A truncated transcription is half an image. Continue it while the provider
	// keeps saying "length", up to two extra rounds, and keep whatever arrives if
	// a continuation fails.
	for (let round = 0; round < 2 && reason === "length"; round += 1) {
		let response;
		let body;
		try {
			response = await fetchWithTimeout(
				url,
				{ method: "POST", headers, body: continuationBody(request, tokensField, budget, output) },
				request.timeoutMs
			);
			body = await response.text();
		} catch {
			break;
		}
		if (!response.ok) break;
		let next;
		try {
			next = JSON.parse(body);
		} catch {
			break;
		}
		let piece;
		try {
			piece = extractAssistantText(next);
		} catch {
			break;
		}
		output = `${output}\n${piece}`;
		reason = finishReasonOf(next);
		request.note?.(`vision-bridge: 转述被截断，已续写第 ${round + 1} 段（共 ${output.length} 字）`);
	}
	return output;
}

/** List models from an OpenAI-compatible endpoint, trying `/v1` when needed. */
async function listModels(baseURL, apiKey, timeoutMs) {
	const root = normalizeBaseURL(baseURL);
	if (root === "") throw new Error("先填端点地址");
	const candidates = [`${root}/models`];
	if (!/\/v\d+$/u.test(root)) candidates.push(`${root}/v1/models`);
	const headers = apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` };
	let lastError;
	for (const url of candidates) {
		try {
			const response = await fetchWithTimeout(url, { headers }, timeoutMs);
			const text = await response.text();
			if (!response.ok) {
				lastError = new Error(`HTTP ${response.status} ${snippet(text)}`);
				continue;
			}
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				lastError = new Error(`返回不是 JSON：${snippet(text)}`);
				continue;
			}
			const rows = Array.isArray(payload)
				? payload
				: Array.isArray(payload?.data)
					? payload.data
					: Array.isArray(payload?.models)
						? payload.models
						: [];
			const models = rows
				.map((entry) => (typeof entry === "string"
					? { id: entry, ownedBy: "" }
					: { id: String(entry?.id ?? entry?.name ?? "").trim(), ownedBy: String(entry?.owned_by ?? entry?.ownedBy ?? "") }))
				.filter((entry) => entry.id !== "");
			if (models.length === 0) {
				lastError = new Error("模型列表为空");
				continue;
			}
			return { url, models };
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error("端点不可达");
}

/** Read one request-sized image and encode it for a data URL. */
async function readImagePayload(attachments, ref, signal) {
	if (attachments === undefined) throw new Error("attachments 服务不可用");
	if (typeof attachments.readImageRequest === "function") {
		const version = await attachments.readImageRequest(ref, REQUEST_IMAGE_POLICY, signal);
		if (version?.data !== undefined && version?.data !== null) {
			return {
				base64: Buffer.from(version.data).toString("base64"),
				mediaType: typeof version.mediaType === "string" ? version.mediaType : (ref.mediaType ?? "image/png")
			};
		}
	}
	if (typeof attachments.readImage === "function") {
		const stored = await attachments.readImage(ref, signal);
		const data = stored?.data ?? stored;
		if (data !== undefined && data !== null) {
			return {
				base64: Buffer.from(data).toString("base64"),
				mediaType: typeof stored?.ref?.mediaType === "string" ? stored.ref.mediaType : (ref.mediaType ?? "image/png")
			};
		}
	}
	throw new Error("读不到图片字节");
}

/** Read a JSON request body off a node HTTP request. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (text.trim() === "") return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

/** Send one JSON response. */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}

/**
 * Install the vision bridge.
 * @param ctx - host context with `settings` and `llm` injected.
 * @param config - loader row config; the settings `base` layer.
 */
function apply(ctx, config = {}) {
	ctx.logger.info("vision-bridge: 插件已加载");

	let disposed = false;

	/** Optional services; each degrades to a logged, inert state when absent. */
	const caps = {
		credentials: undefined,
		attachments: undefined,
		webServer: undefined,
		agents: undefined
	};

	/** Row-config validation, used as the settings `base` layer. */
	const resolveRow = () => {
		try {
			return Object.freeze(SettingsSchema({ ...DEFAULTS, ...config }));
		} catch (error) {
			ctx.logger.warn(`vision-bridge: 行配置无效，改用默认值：${renderThrown(error)}`);
			return Object.freeze({ ...DEFAULTS });
		}
	};

	/** Live normalized configuration. */
	let live = normalizeConfig(resolveRow());

	/** Resolved credential value (`VISION_BRIDGE_API_KEY`), "" when absent. */
	let credentialValue = "";
	let credentialResolved = false;

	/** Derived activation state; recomputed whenever settings or key change. */
	let readyState = readinessOf(live, credentialValue);

	/** Counters surfaced on the panel and in `/api/vision-bridge/status`. */
	const stats = {
		requests: 0,
		bridged: 0,
		images: 0,
		described: 0,
		cached: 0,
		nativeSkips: 0,
		failed: 0,
		lastLatencyMs: 0,
		lastError: ""
	};

	/** Declared (unforced) image capability per provider/model, filled by the wrap. */
	const declaredCapability = new Map();

	/** Forced modality overrides, keyed provider\0model. */
	const forcedInfo = new Map();

	/** Transcription cache: key → { text, at }. */
	const cache = new Map();
	let cacheTimer;

	/** Recompute activation from the current settings + credential. */
	function refresh() {
		readyState = readinessOf(live, credentialValue);
		forcedInfo.clear();
	}

	/** Whether the bridge may act at all right now. */
	function ready() {
		return !disposed && readyState.active;
	}

	// ── settings ────────────────────────────────────────────────────────────
	try {
		const scope = ctx.settings.register(NAMESPACE, SettingsSchema, { base: resolveRow() });
		live = normalizeConfig(scope.get());
		refresh();
		scope.watch(() => {
			live = normalizeConfig(scope.get());
			refresh();
			ctx.logger.info(
				`vision-bridge: 配置已更新（mode=${live.mode}, endpoint=${live.baseURL === "" ? "未设置" : live.baseURL}, `
				+ `model=${live.model === "" ? "未设置" : live.model}, active=${readyState.active}）`
			);
		});
	} catch (error) {
		ctx.logger.warn(`vision-bridge: settings 命名空间不可用，仅按行配置运行：${renderThrown(error)}`);
	}

	// ── modality wrap ───────────────────────────────────────────────────────
	/**
	 * Wrap `resolveModelInfo` so a text-only route also reports `image`.
	 *
	 * The wrap lives on the prototype because cordis hands out a tracked proxy
	 * whose property sets land on a shadow receiver — an instance-level
	 * assignment would vanish. The record on the prototype is shared, so a
	 * plugin reload re-arms the existing wrapper instead of stacking a second
	 * one on top of a stale closure.
	 *
	 * @returns {number} how many prototypes are armed.
	 */
	function installModalityWrap() {
		const targets = new Set();
		const consider = (holder) => {
			try {
				if (holder === null || holder === undefined) return;
				const proto = Object.getPrototypeOf(holder);
				if (proto !== null && typeof proto.resolveModelInfo === "function") targets.add(proto);
			} catch {
				/* exotic holder — skip */
			}
		};
		consider(ctx.llm);
		// Other LlmRuntime instances in this process (mirrors, realm copies).
		try {
			const store = ctx.reflect?.store;
			for (const entry of Object.values(store ?? {})) {
				const value = entry?.value;
				if (value !== null && typeof value === "object" && typeof value.resolveModelInfo === "function" && typeof value.stream === "function") consider(value);
			}
		} catch {
			/* reflect store unavailable — the injected instance still got patched */
		}
		let armed = 0;
		for (const proto of targets) {
			let record = Object.hasOwn(proto, PATCH_MARK) ? proto[PATCH_MARK] : undefined;
			if (record === undefined) {
				record = { original: proto.resolveModelInfo, state: undefined };
				Object.defineProperty(proto, PATCH_MARK, {
					value: record,
					enumerable: false,
					configurable: true,
					writable: false
				});
				proto.resolveModelInfo = async function resolveModelInfo(provider, model, signal) {
					const info = await record.original.call(this, provider, model, signal);
					if (info === null || typeof info !== "object") return info;
					const state = record.state;
					if (state === undefined) return info;
					const declared = Array.isArray(info.inputModalities) ? info.inputModalities : undefined;
					const capable = declared !== undefined && declared.includes("image");
					const key = `${provider}\u0000${model}`;
					state.declared.set(key, { capable, at: Date.now() });
					if (capable || !state.armed()) return info;
					const cached = state.forced.get(key);
					if (cached !== undefined && Date.now() - cached.at < FORCED_TTL_MS) return cached.value;
					const widened = Object.freeze({
						...info,
						inputModalities: Object.freeze([...(declared ?? ["text"]), "image"])
					});
					state.forced.set(key, { value: widened, at: Date.now() });
					return widened;
				};
			}
			record.state = {
				armed: () => ready(),
				declared: declaredCapability,
				forced: forcedInfo
			};
			armed += 1;
		}
		return armed;
	}

	ctx.logger.info(`vision-bridge: 模态放行已挂载（${installModalityWrap()} 个 LlmRuntime）`);
	// Adapters can be swapped at runtime (model catalog reload); re-arm so a
	// newly mounted runtime is covered too.
	ctx.on("llm/adapters-updated", () => {
		try {
			installModalityWrap();
		} catch (error) {
			ctx.logger.warn(`vision-bridge: 重新挂载模态放行失败：${renderThrown(error)}`);
		}
	});

	// ── credentials ─────────────────────────────────────────────────────────
	const probeCredential = async () => {
		if (caps.credentials === undefined) {
			credentialResolved = true;
			refresh();
			return;
		}
		try {
			const hit = await caps.credentials.resolve(CREDENTIAL_REF);
			credentialValue = typeof hit?.value === "string" ? hit.value : "";
		} catch (error) {
			credentialValue = "";
			ctx.logger.warn(`vision-bridge: 读取 ${CREDENTIAL_REF} 失败：${renderThrown(error)}`);
		}
		credentialResolved = true;
		refresh();
	};

	ctx.on("credentials/reference-updated", (ref) => {
		if (ref !== CREDENTIAL_REF) return;
		void probeCredential();
	});

	// ── transcription cache ─────────────────────────────────────────────────
	let cacheLoaded = false;
	const cachePath = () => path.join(dshHome(), CACHE_FILE);

	const loadCache = async () => {
		if (cacheLoaded) return;
		cacheLoaded = true;
		try {
			const text = await fs.readFile(cachePath(), "utf8");
			const parsed = JSON.parse(text);
			const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
			for (const entry of entries) {
				if (!Array.isArray(entry) || entry.length !== 2) continue;
				const [key, value] = entry;
				if (typeof key !== "string" || value === null || typeof value !== "object") continue;
				if (typeof value.text !== "string" || typeof value.at !== "number") continue;
				cache.set(key, { text: value.text, at: value.at });
			}
			ctx.logger.info(`vision-bridge: 转述缓存已载入 ${cache.size} 条`);
		} catch (error) {
			if (error?.code !== "ENOENT") ctx.logger.warn(`vision-bridge: 缓存读取失败：${renderThrown(error)}`);
		}
	};

	const trimCache = () => {
		const kept = [...cache.entries()].sort((left, right) => right[1].at - left[1].at).slice(0, CACHE_MAX_ENTRIES);
		cache.clear();
		for (const entry of kept) cache.set(entry[0], entry[1]);
	};

	const saveCacheSoon = () => {
		if (cacheTimer !== undefined) return;
		cacheTimer = setTimeout(() => {
			cacheTimer = undefined;
			void (async () => {
				try {
					trimCache();
					await fs.mkdir(dshHome(), { recursive: true });
					await fs.writeFile(
						cachePath(),
						`${JSON.stringify({ version: 1, entries: [...cache.entries()] }, null, 2)}\n`,
						{ mode: 0o600 }
					);
				} catch (error) {
					ctx.logger.warn(`vision-bridge: 缓存写入失败：${renderThrown(error)}`);
				}
			})();
		}, 1_500);
		cacheTimer.unref?.();
	};

	const cacheGet = (key) => {
		const hit = cache.get(key);
		if (hit === undefined) return undefined;
		if (Date.now() - hit.at > CACHE_TTL_MS) {
			cache.delete(key);
			return undefined;
		}
		return hit.text;
	};

	const cacheSet = (key, text) => {
		cache.set(key, { text, at: Date.now() });
		if (cache.size > CACHE_MAX_ENTRIES * 2) trimCache();
		saveCacheSoon();
	};

	// ── bridging ────────────────────────────────────────────────────────────
	/** Requests produced by this plugin, so re-entry never loops. */
	const bridged = new WeakSet();

	/**
	 * Whether the routed route can see images natively. Consults the DECLARED
	 * capability recorded by the wrap; warming it through one `resolveModelInfo`
	 * call keeps this correct even before any prompt ever resolved the route.
	 * @returns {Promise<boolean>} true when the route declares image input.
	 */
	async function nativeImageCapable(provider, model, signal) {
		try {
			await ctx.llm.resolveModelInfo(provider, model, signal);
		} catch {
			/* unknown route — treat as text-only and transcribe */
		}
		return declaredCapability.get(`${provider}\u0000${model}`)?.capable === true;
	}

	/** True when this request belongs to a subagent we were told to leave alone. */
	function outOfScope(options) {
		if (live.includeSubagents) return false;
		const agents = caps.agents;
		const sessionId = options?.sessionId;
		if (agents === undefined || typeof sessionId !== "string") return false;
		try {
			const agent = agents.get(sessionId);
			if (agent === undefined) return false;
			return !agents.roots().includes(agent);
		} catch {
			return false;
		}
	}

	/**
	 * Transcribe one image into the text that stands in for it. Never throws:
	 * a vision failure becomes an explicit gap in the prompt.
	 * @param attachment - image ref from the request.
	 * @param context - routed provider/model plus focus and abort signal.
	 * @returns {Promise<string>} the replacement text.
	 */
	async function describeAttachment(attachment, context) {
		const visionModel = live.model;
		const prompt = buildPrompt(live.prompt === "" ? DEFAULT_PROMPT : live.prompt, context.focus);
		const key = transcriptionKey(attachment, visionModel, prompt);
		if (live.cacheEnabled) {
			const hit = cacheGet(key);
			if (hit !== undefined) {
				stats.cached += 1;
				return formatDescription(hit, { attachment, model: visionModel });
			}
		}
		const started = Date.now();
		try {
			const image = await readImagePayload(caps.attachments, attachment, context.signal);
			const text = await callVision({
				baseURL: readyState.baseURL,
				[API_KEY]: readyState.key,
				model: visionModel,
				prompt,
				maxTokens: live.maxTokens,
				timeoutMs: live.timeoutMs,
				note: (message) => ctx.logger.info(message),
				dataURL: `data:${image.mediaType};base64,${image.base64}`
			});
			stats.described += 1;
			stats.lastLatencyMs = Date.now() - started;
			if (live.cacheEnabled) cacheSet(key, text);
			ctx.logger.info(`vision-bridge: 转述完成（${text.length} 字 / ${stats.lastLatencyMs}ms，模型 ${visionModel}）`);
			return formatDescription(text, { attachment, model: visionModel });
		} catch (error) {
			stats.failed += 1;
			stats.lastError = renderThrown(error);
			ctx.logger.warn(`vision-bridge: 转述失败：${stats.lastError}`);
			return formatFailure(stats.lastError, { attachment, model: visionModel });
		}
	}

	/**
	 * Produce the bridged request for one outgoing call.
	 * @returns {Promise<object>} the original request when nothing changed.
	 */
	async function bridgeRequest(options) {
		const provider = String(options.provider ?? "");
		const model = String(options.model ?? "");
		if (live.mode === "auto" && await nativeImageCapable(provider, model, options.signal)) {
			stats.nativeSkips += 1;
			return options;
		}
		const focus = live.focusFromUserText ? focusOf(options.messages) : "";
		const messages = [];
		let changed = false;
		let images = 0;
		for (const message of options.messages) {
			if (message === null || typeof message !== "object" || !Array.isArray(message.content)) {
				messages.push(message);
				continue;
			}
			const result = await replaceImagesDeep(message.content, (attachment) => describeAttachment(attachment, {
				provider,
				model,
				focus,
				signal: options.signal
			}));
			images += result.count;
			if (result.changed) {
				changed = true;
				messages.push({ ...message, content: result.content });
			} else {
				messages.push(message);
			}
		}
		if (!changed) return options;
		const request = Object.freeze({ ...options, messages: Object.freeze(messages) });
		bridged.add(request);
		stats.bridged += 1;
		stats.images += images;
		ctx.logger.info(
			`vision-bridge: ${images} 张图片转入视觉模型 ${live.model}（主模型 ${provider}/${model} 不识图，mode=${live.mode}）`
		);
		return request;
	}

	ctx.effect(function* () {
		ctx.on("llm/stream", (options, next) => {
			try {
				if (disposed || !ready()) return next();
				if (options === null || typeof options !== "object" || bridged.has(options)) return next();
				if (!messagesHaveImage(options.messages)) return next();
				if (outOfScope(options)) return next();
			} catch (error) {
				ctx.logger.warn(`vision-bridge: 请求预检失败，直通：${renderThrown(error)}`);
				return next();
			}
			stats.requests += 1;
			// The waterfall hands downstream listeners one shared args array, so
			// the transformed request cannot be passed through `next()`. Return a
			// lazy stream instead: transcribe, then dispatch the bridged request
			// (or the untouched `next` chain when nothing changed).
			return (async function* bridgedStream() {
				let request = options;
				try {
					request = await bridgeRequest(options);
				} catch (error) {
					ctx.logger.warn(`vision-bridge: 转述流程异常，直通：${renderThrown(error)}`);
					request = options;
				}
				const stream = request === options ? next() : ctx.llm.stream(request);
				for await (const chunk of stream) yield chunk;
			})();
		});

		yield () => {
			disposed = true;
			if (cacheTimer !== undefined) {
				clearTimeout(cacheTimer);
				cacheTimer = undefined;
			}
		};
	}, "vision-bridge: stream bridge");

	void loadCache();

	// ── HTTP surface for the panel ──────────────────────────────────────────
	const statusPayload = () => ({
		ok: true,
		active: ready(),
		mode: live.mode,
		missing: readyState.missing,
		baseURL: live.baseURL,
		model: live.model,
		keySource: readyState.keySource,
		keyConfigured: readyState.key !== "",
		credentialRef: CREDENTIAL_REF,
		credentialResolved: credentialResolved,
		maxTokens: live.maxTokens,
		timeoutMs: live.timeoutMs,
		focusFromUserText: live.focusFromUserText,
		includeSubagents: live.includeSubagents,
		cacheEnabled: live.cacheEnabled,
		promptOverridden: live.prompt.trim() !== "",
		stats: { ...stats },
		cacheEntries: cache.size,
		declared: [...declaredCapability.entries()]
			.slice(-24)
			.map(([key, value]) => {
				const [provider, model] = key.split("\u0000");
				return { provider, model, image: value.capable };
			})
	});

	/** Pick the first non-empty string among staged body fields. */
	const firstNonEmpty = (...values) => {
		for (const value of values) {
			const text = String(value ?? "").trim();
			if (text !== "") return text;
		}
		return "";
	};

	const registerRoutes = () => {
		const webServer = caps.webServer;
		if (webServer === undefined || typeof webServer.register !== "function") return;
		ctx.effect(() => {
			const dispose = webServer.register({
				kind: "exact",
				path: "/api/vision-bridge/status",
				handler: (_req, res) => {
					sendJson(res, 200, statusPayload());
				}
			});
			const disposeModels = webServer.register({
				kind: "exact",
				path: "/api/complugin/vision/models",
				handler: async (req, res) => {
					try {
						const body = await readJsonBody(req);
						const staged = body.values ?? {};
						const baseURL = firstNonEmpty(staged.baseURL, body.baseURL) || live.baseURL;
						const stagedKey = firstNonEmpty(staged.apiKey, body.apiKey);
						const key = stagedKey === "" ? readyState.key : stagedKey;
						const listed = await listModels(baseURL, key, live.timeoutMs);
						sendJson(res, 200, { ok: true, url: listed.url, models: listed.models.map((entry) => entry.id), detail: `拉到 ${listed.models.length} 个模型（${listed.url}）`, data: { models: listed.models } });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error), detail: renderThrown(error) });
					}
				}
			});
			const disposeTest = webServer.register({
				kind: "exact",
				path: "/api/complugin/vision/test",
				handler: async (req, res) => {
					const started = Date.now();
					try {
						const body = await readJsonBody(req);
						const staged = body.values ?? {};
						const baseURL = firstNonEmpty(staged.baseURL, body.baseURL) || live.baseURL;
						const stagedKey = firstNonEmpty(staged.apiKey, body.apiKey);
						const key = stagedKey === "" ? readyState.key : stagedKey;
						const model = firstNonEmpty(staged.model, body.model) || live.model;
						if (model === "") throw new Error("先填模型名，或点“拉取模型”选一个");
						const text = await callVision({
							baseURL,
							[API_KEY]: key,
							model,
							prompt: "这张图片是什么颜色？只回答颜色名，不要解释。",
							maxTokens: 64,
							timeoutMs: live.timeoutMs,
							dataURL: TEST_IMAGE_URL
						});
						sendJson(res, 200, { ok: true, text, ms: Date.now() - started, model, detail: `${model} 用时 ${Date.now() - started} ms`, data: { text, ms: Date.now() - started } });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error), ms: Date.now() - started, detail: renderThrown(error) });
					}
				}
			});
			const disposeKey = webServer.register({
				kind: "exact",
				path: "/api/complugin/vision/key",
				handler: async (req, res) => {
					try {
						if (caps.credentials === undefined) throw new Error("credentials 服务不可用，请把密钥填在 apiKey 字段");
						const body = await readJsonBody(req);
						const staged = body.values ?? {};
						const value = firstNonEmpty(staged.apiKey, body.apiKey);
						if (value === "") await caps.credentials.unset(CREDENTIAL_REF);
						else await caps.credentials.set(CREDENTIAL_REF, value);
						await probeCredential();
						sendJson(res, 200, { ok: true, detail: value === "" ? "已清除密钥" : "密钥已保存到凭据库", ...statusPayload() });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error), detail: renderThrown(error) });
					}
				}
			});
			const disposeCache = webServer.register({
				kind: "exact",
				path: "/api/complugin/vision/cache",
				handler: async (req, res) => {
					try {
						if (req.method === "DELETE" || req.method === "POST") {
							cache.clear();
							saveCacheSoon();
						}
						sendJson(res, 200, { ok: true, cacheEntries: cache.size, detail: "图片转述缓存已清空" });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error), detail: renderThrown(error) });
					}
				}
			});
			return () => {
				for (const off of [dispose, disposeModels, disposeTest, disposeKey, disposeCache]) {
					try {
						off?.();
					} catch {
						/* already gone */
					}
				}
			};
		}, "vision-bridge: http routes");
		ctx.logger.info("vision-bridge: 面板路由已挂载（/api/complugin/vision/*）");
	};

	// ── optional services ───────────────────────────────────────────────────
	for (const service of ["credentials", "attachments", "webServer", "agents"]) {
		try {
			ctx.inject([service], (sctx) => {
				caps[service] = sctx[service];
				ctx.logger.info(`vision-bridge: ${service} 服务可用`);
				if (service === "credentials") void probeCredential();
				if (service === "webServer") registerRoutes();
			});
		} catch (error) {
			ctx.logger.warn(`vision-bridge: ${service} 服务不可用：${renderThrown(error)}`);
		}
	}

	// If no credentials service ever mounts, stop waiting on the probe.
	void Promise.resolve().then(() => {
		if (!credentialResolved && caps.credentials === undefined) {
			credentialResolved = true;
			refresh();
		}
	});

	ctx.logger.info(
		`vision-bridge: 就绪（active=${ready()}，mode=${live.mode}，`
		+ `缺项=${readyState.missing.length === 0 ? "无" : readyState.missing.join("/")}）`
	);

	/** Status for the merged panel (fed to `describeModule`). */
	return {
		status: () => {
			const missing = Array.isArray(readyState.missing) ? readyState.missing : [];
			const active = ready();
			return {
				ready: active,
				sign: active ? "on" : "idle",
				badge: active ? (live.mode === "always" ? "总是转述" : "自动转述") : "未就绪",
				line: active
					? `${live.model} · 已转述 ${stats.described} 张，缓存 ${cache.size} 条`
					: `缺项：${missing.length === 0 ? "无" : missing.join(" / ")}`,
				stats: [
					{ label: "请求", value: String(stats.requests) },
					{ label: "转述", value: String(stats.described) },
					{ label: "缓存命中", value: String(stats.cached) },
					{ label: "原生跳过", value: String(stats.nativeSkips) },
					{ label: "失败", value: String(stats.failed) }
				],
				entries: [...declaredCapability.entries()]
					.slice(-6)
					.reverse()
					.map(([key, value]) => {
						const [provider, model] = key.split("\u0000");
						return { level: value.capable ? "info" : "warn", text: `${provider}/${model} → ${value.capable ? "原生视觉" : "由视觉桥转述"}`, at: 0 };
					})
			};
		}
	};
}

export { apply, inject, name, DEFAULTS, MODES, NAMESPACE, CREDENTIAL_REF, SettingsSchema, callVision, listModels };

/** Module declaration consumed by `complugin`. */
export default defineModule({
	id: "visionBridge",
	kind: "hook",
	order: 30,
	title: "视觉桥",
	summary: "给纯文本模型接上眼睛：图片照收，由视觉模型转述成文字再送进对话。",
	legacy: "vision-bridge",
	inject: ["llm"],
	docs: "只在路由模型确实没有视觉能力时介入；会话历史里的图片不会被改写，换成多模态模型后自动恢复原生视觉。",
	fields: [
		{
			key: "mode",
			label: "工作模式",
			type: "select",
			group: "basic",
			default: "auto",
			options: [
				{ value: "auto", label: "自动", hint: "仅当路由模型没有视觉能力时才转述（推荐）" },
				{ value: "always", label: "总是", hint: "即使模型自带视觉也改成文字转述" },
				{ value: "off", label: "关闭", hint: "完全不介入，图片按宿主默认行为处理" }
			],
			hint: "自动模式最省事：有眼睛的模型走原生，没眼睛的走转述。"
		},
		{
			key: "baseURL",
			label: "接口地址",
			type: "text",
			group: "basic",
			default: "",
			placeholder: "https://open.bigmodel.cn/api/paas/v4",
			hint: "OpenAI 兼容的 /chat/completions 基址，通常到 /v4 或 /v1 为止。"
		},
		{
			key: "model",
			label: "视觉模型",
			type: "text",
			group: "basic",
			default: "",
			placeholder: "glm-4v-plus",
			hint: "必须是真的支持图片输入的模型。点「拉取模型」可以从接口列出候选。"
		},
		{
			key: "apiKey",
			label: "API 密钥",
			type: "secret",
			group: "basic",
			default: "",
			placeholder: "留空则沿用已保存的密钥",
			hint: "填入后点「保存密钥」写入 DSH 凭据库；面板不回显已保存的密钥。"
		},
		{
			key: "prompt",
			label: "转述提示词",
			type: "textarea",
			group: "tuning",
			default: "",
			rows: 5,
			hint: "留空使用内置提示词：保留文字、数字、位置关系与界面结构。"
		},
		{
			key: "maxTokens",
			label: "转述长度上限",
			type: "number",
			group: "tuning",
			default: 1024,
			min: 64,
			max: 16384,
			step: 1,
			unit: "tokens",
			hint: "默认 1024。部分模型上限就是 1024（如 glm-4v-flash），超了会被接口拒绝，插件会自动下调重试。"
		},
		{
			key: "timeoutMs",
			label: "单次超时",
			type: "number",
			group: "tuning",
			default: 60000,
			min: 5000,
			max: 300000,
			step: 100,
			unit: "ms",
			hint: "一张图一次请求的超时。大图或思考型模型建议放宽到 120000 以上。"
		},
		{
			key: "focusFromUserText",
			label: "按提问聚焦",
			type: "switch",
			group: "advanced",
			default: true,
			hint: "把你最近一句提问带上，让转述重点贴合你想问的东西。"
		},
		{
			key: "includeSubagents",
			label: "包含子 agent",
			type: "switch",
			group: "advanced",
			default: true,
			hint: "子 agent 的请求也走视觉桥。"
		},
		{
			key: "cacheEnabled",
			label: "复用转述结果",
			type: "switch",
			group: "advanced",
			default: true,
			hint: "同一张图 + 同一模型 + 同一提示词只转述一次，缓存 14 天。"
		}
	],
	actions: [
		{ id: "models", label: "拉取模型", desc: "按当前接口地址和密钥列出可用模型", route: "/api/complugin/vision/models", resultField: "model" },
		{ id: "test", label: "测试视觉", desc: "发一张内置测试图，验证接口、模型与密钥", route: "/api/complugin/vision/test" },
		{ id: "saveKey", label: "保存密钥", desc: "把密钥字段写入 DSH 凭据库", route: "/api/complugin/vision/key", needs: ["apiKey"] },
		{ id: "clearCache", label: "清空缓存", desc: "丢弃已缓存的图片转述", route: "/api/complugin/vision/cache", tone: "danger", confirm: "确定清空所有已缓存的图片转述？" }
	],
	mount({ ctx, config }) {
		return apply(ctx, config()) ?? {};
	}
});
