/**
 * Host-half integration tests: apply the plugin to a mock cordis context and
 * drive the two mechanisms that matter — modality admission and the request
 * bridge — without a live harness.
 *
 * The mock reproduces only the surface the plugin actually touches:
 * `settings.register` + scope, `inject` (one service at a time, absent services
 * never call back the way cordis waits on them), `on`, `effect`, `logger`, and
 * a LlmRuntime-shaped class whose `resolveModelInfo` is a prototype method —
 * which is the whole point of the wrap.
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Point the bridge's cache at a throwaway home before the module reads it.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vb-home-"));

const { apply } = await import("../lib/index.js");
const { DEFAULTS } = await import("../lib/core/vision.js");

const IMAGE = Object.freeze({
	attachmentId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	mediaType: "image/png",
	bytes: 2048,
	width: 800,
	height: 600
});

/** Fresh LlmRuntime-shaped class per context, so patches never leak between tests. */
function makeLlm(declaredFor) {
	class LlmRuntime {
		constructor() {
			this.streamed = [];
			this.streamCalls = 0;
		}
		async resolveModelInfo(provider, model) {
			return { provider, model, inputModalities: declaredFor(provider, model) };
		}
		stream(options) {
			this.streamCalls += 1;
			this.streamed.push(options);
			return (async function* pumped() {
				yield { kind: "provider", index: this === undefined ? 0 : 0 };
			})();
		}
	}
	return new LlmRuntime();
}

/**
 * Build a mock host context.
 * @param {object} options - settings, services, declared modalities.
 * @returns mock context plus inspection handles.
 */
function makeCtx(options = {}) {
	const logs = [];
	const listeners = new Map();
	const routes = new Map();
	const disposers = [];
	const watchers = new Set();
	const effective = {
		enabled: true,
		modules: { visionBridge: { ...DEFAULTS, ...(options.settings ?? {}) } }
	};
	const llm = options.llm ?? makeLlm(() => ["text"]);
	const services = {
		attachments: ATTACHMENTS,
		webServer: {
			register: (route) => {
				routes.set(route.path, route.handler);
				return () => routes.delete(route.path);
			}
		},
		agents: { roots: () => [], get: () => undefined },
		...(options.services ?? {})
	};

	const record = (level) => (message) => {
		logs.push({ level, message: String(message) });
	};

	const scope = {
		get: () => effective,
		watch: (cb) => {
			watchers.add(cb);
			return () => watchers.delete(cb);
		},
		update: async (patch) => {
			Object.assign(effective, patch);
			for (const cb of watchers) cb();
		},
		replace: async (next) => {
			Object.assign(effective, next);
			for (const cb of watchers) cb();
		},
		set: async (field, value) => {
			effective.modules.visionBridge[field] = value;
			for (const cb of watchers) cb();
		},
		unset: async (field) => {
			effective.modules.visionBridge[field] = DEFAULTS[field];
			for (const cb of watchers) cb();
		}
	};

	const settingsService = { register: () => scope };
	services.settings = settingsService;

	const ctx = {
		logger: { info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") },
		llm,
		settings: settingsService,
		inject: (names, cb) => {
			const name = names[0];
			const service = services[name];
			if (service === undefined) return () => false;
			cb({ [name]: service });
			return () => true;
		},
		on: (name, fn) => {
			const list = listeners.get(name) ?? [];
			list.push(fn);
			listeners.set(name, list);
			return () => {
				const index = list.indexOf(fn);
				if (index >= 0) list.splice(index, 1);
				return index >= 0;
			};
		},
		effect: (execute) => {
			// Cordis drives a generator effect to its first yield immediately and
			// collects every yielded disposer — replicate exactly that.
			const result = execute();
			if (typeof result === "function") {
				disposers.push(result);
			} else if (result !== null && typeof result === "object" && Symbol.iterator in result) {
				const iter = result[Symbol.iterator]();
				while (true) {
					const step = iter.next();
					if (typeof step.value === "function") disposers.push(step.value);
					if (step.done) break;
				}
			}
			return () => {};
		}
	};

	apply(ctx, options.row ?? {});

	return {
		ctx,
		scope,
		logs,
		routes,
		listeners,
		llm,
		watchers,
		dispose: () => {
			for (const fn of disposers) fn();
		}
	};
}

/** A stubbed fetch that answers like an OpenAI-compatible endpoint. */
function stubFetch(handler) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		const result = await handler(String(url), init);
		return {
			ok: result.status === undefined || result.status < 400,
			status: result.status ?? 200,
			async text() {
				return typeof result.body === "string" ? result.body : JSON.stringify(result.body);
			}
		};
	};
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		}
	};
}

const COMPLETE = Object.freeze({
	baseURL: "https://vision.test/v1",
	model: "vision-model-1",
	apiKey: "your_api_key"
});

const ATTACHMENTS = Object.freeze({
	readImageRequest: async () => ({ data: Buffer.from([137, 80, 78, 71]), mediaType: "image/png" })
});

test("unconfigured: the modality wrap is a straight pass-through", async () => {
	const ctx = makeCtx();
	const info = await ctx.ctx.llm.resolveModelInfo("oc", "deepseek-v4.1-flash-free");
	assert.deepEqual(info.inputModalities, ["text"]);
	assert.equal(ctx.logs.some((entry) => entry.message.includes("模态放行已挂载")), true);
});

test("configured: a text-only route reports image input, a multimodal route is unchanged", async () => {
	const llm = makeLlm((provider, model) => (model === "vision-native" ? ["text", "image"] : ["text"]));
	const ctx = makeCtx({
		llm,
		settings: { ...COMPLETE },
		services: { attachments: ATTACHMENTS }
	});

	const forced = await llm.resolveModelInfo("oc", "deepseek-v4.1-flash-free");
	assert.deepEqual([...forced.inputModalities], ["text", "image"]);

	const native = await llm.resolveModelInfo("oc", "vision-native");
	assert.deepEqual([...native.inputModalities], ["text", "image"]);
});

test("auto mode: an image on a text-only route is transcribed and the request is re-dispatched", async () => {
	const llm = makeLlm(() => ["text"]);
	const ctx = makeCtx({ llm, settings: { ...COMPLETE }, services: { attachments: ATTACHMENTS } });
	const listener = ctx.listeners.get("llm/stream")[0];
	assert.equal(typeof listener, "function");

	const fetchStub = stubFetch(() => ({ body: { choices: [{ message: { content: "一张终端截图：\nERROR boom" } }] } }));
	try {
		const options = {
			provider: "oc",
			model: "deepseek-v4.1-flash-free",
			messages: [
				{ role: "system", content: [{ type: "text", text: "你是助手" }] },
				{ role: "user", content: [{ type: "text", text: "这个报错什么意思" }, { type: "image", attachment: IMAGE }] }
			]
		};
		let nextCalls = 0;
		const stream = listener(options, () => {
			nextCalls += 1;
			return (async function* native() {
				yield { kind: "untouched" };
			})();
		});

		const chunks = [];
		for await (const chunk of stream) chunks.push(chunk);

		assert.equal(nextCalls, 0, "the original chain must not run");
		assert.equal(fetchStub.calls.length, 1);
		assert.equal(fetchStub.calls[0].url, "https://vision.test/v1/chat/completions");
		const body = JSON.parse(fetchStub.calls[0].init.body);
		assert.equal(body.model, "vision-model-1");
		assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/u);
		assert.equal(body.max_tokens, DEFAULTS.maxTokens);

		assert.equal(chunks.length, 1);
		assert.equal(chunks[0].kind, "provider");

		const dispatched = llm.streamed[0];
		assert.ok(dispatched, "the bridged request reached the runtime");
		const userContent = dispatched.messages[1].content;
		assert.equal(userContent.length, 2);
		assert.equal(userContent[1].type, "text");
		assert.match(userContent[1].text, /vision-bridge 视觉桥/u);
		assert.match(userContent[1].text, /ERROR boom/u);
		assert.match(userContent[1].text, /sha256:aaaaaaaaaaaa/u);
		assert.match(userContent[1].text, /800x600/u);
		assert.equal(userContent.some((block) => block.type === "image"), false);
		assert.equal(options.messages[1].content[1].type, "image", "the caller's request must stay untouched");

		// Second pass with the same bytes serves from cache.
		const again = listener({ ...options, messages: options.messages.slice() }, () => {
			throw new Error("must not fall through");
		});
		for await (const _chunk of again) {
			/* drain */
		}
		assert.equal(fetchStub.calls.length, 1, "cache hit must not call the endpoint twice");

		const status = await new Promise((resolve) => {
			ctx.routes.get("/api/vision-bridge/status")({}, {
				writeHead: () => {},
				end: (body) => resolve(JSON.parse(body))
			});
		});
		assert.equal(status.ok, true);
		assert.equal(status.active, true);
		assert.equal(status.model, "vision-model-1");
		assert.equal(status.stats.described, 1);
		assert.equal(status.stats.cached, 1);
		assert.equal(status.stats.bridged, 2);
	} finally {
		fetchStub.restore();
		ctx.dispose();
	}
});

test("auto mode: a natively multimodal route is left alone", async () => {
	const llm = makeLlm(() => ["text", "image"]);
	const ctx = makeCtx({ llm, settings: { ...COMPLETE }, services: { attachments: ATTACHMENTS } });
	const listener = ctx.listeners.get("llm/stream")[0];
	const fetchStub = stubFetch(() => ({ body: { choices: [{ message: { content: "should not run" } }] } }));
	try {
		let nextCalls = 0;
		const stream = listener({
			provider: "oc",
			model: "vision-native",
			messages: [{ role: "user", content: [{ type: "image", attachment: IMAGE }] }]
		}, () => {
			nextCalls += 1;
			return (async function* native() {
				yield { kind: "native" };
			})();
		});
		const chunks = [];
		for await (const chunk of stream) chunks.push(chunk);
		assert.equal(nextCalls, 1);
		assert.equal(chunks[0].kind, "native");
		assert.equal(fetchStub.calls.length, 0);
		assert.equal(llm.streamCalls, 0);
	} finally {
		fetchStub.restore();
		ctx.dispose();
	}
});

test("a vision failure degrades to an explicit gap, never to a dead turn", async () => {
	const llm = makeLlm(() => ["text"]);
	const ctx = makeCtx({ llm, settings: { ...COMPLETE, cacheEnabled: false }, services: { attachments: ATTACHMENTS } });
	const listener = ctx.listeners.get("llm/stream")[0];
	const fetchStub = stubFetch(() => ({ status: 401, body: { error: "invalid api key" } }));
	try {
		const stream = listener({
			provider: "oc",
			model: "deepseek-v4.1-flash-free",
			messages: [{ role: "user", content: [{ type: "image", attachment: IMAGE }] }]
		}, () => (async function* native() {
			yield { kind: "untouched" };
		})());
		for await (const _chunk of stream) {
			/* drain */
		}
		const dispatched = llm.streamed[0];
		const text = dispatched.messages[0].content[0].text;
		assert.match(text, /转述失败/u);
		assert.match(text, /401/u);
		assert.equal(ctx.logs.some((entry) => entry.level === "warn" && entry.message.includes("转述失败")), true);
	} finally {
		fetchStub.restore();
		ctx.dispose();
	}
});

test("off mode and missing key both restore native behaviour", async () => {
	for (const settings of [{ ...COMPLETE, mode: "off" }, { baseURL: COMPLETE.baseURL, model: COMPLETE.model }]) {
		const llm = makeLlm(() => ["text"]);
		const ctx = makeCtx({ llm, settings, services: { attachments: ATTACHMENTS } });
		const info = await llm.resolveModelInfo("oc", "deepseek-v4.1-flash-free");
		assert.deepEqual(info.inputModalities, ["text"], `pass-through expected for ${JSON.stringify(settings)}`);
		const listener = ctx.listeners.get("llm/stream")[0];
		let nextCalls = 0;
		await (async () => {
			for await (const _chunk of listener(
				{ provider: "oc", model: "m", messages: [{ role: "user", content: [{ type: "image", attachment: IMAGE }] }] },
				() => {
					nextCalls += 1;
					return (async function* native() {
						yield 1;
					})();
				}
			)) {
				/* drain */
			}
		})();
		assert.equal(nextCalls, 1);
		ctx.dispose();
	}
});

test("models route lists ids and reports endpoint errors without throwing", async () => {
	const ctx = makeCtx({ settings: { ...COMPLETE }, services: { attachments: ATTACHMENTS } });
	const handler = ctx.routes.get("/api/complugin/vision/models");
	assert.equal(typeof handler, "function");

	/** Minimal request emitter `readJsonBody` accepts. */
	const request = (payload) => {
		const handlers = {};
		const emitter = {
			on: (event, cb) => {
				handlers[event] = cb;
				if (event === "data") setImmediate(() => cb(Buffer.from(JSON.stringify(payload))));
				if (event === "end") setImmediate(() => cb());
				return emitter;
			}
		};
		return emitter;
	};
	/** Minimal response sink that resolves with the parsed JSON body. */
	const respond = (body) => new Promise((resolve) => {
		handler(request(body), {
			writeHead: () => {},
			end: (text) => resolve(JSON.parse(text))
		});
	});

	const fetchStub = stubFetch((url) => {
		if (url.includes("/models")) return { body: { data: [{ id: "vision-model-1" }, { id: "vision-model-2" }] } };
		return { status: 404, body: { error: "nope" } };
	});
	try {
		const listed = await respond({ baseURL: "https://vision.test/v1" });
		assert.equal(listed.ok, true);
		assert.deepEqual(listed.models.map((model) => model.id), ["vision-model-1", "vision-model-2"]);

		// No endpoint in the body → the saved endpoint is used.
		const saved = await respond({});
		assert.equal(saved.ok, true);
		assert.equal(saved.models.length, 2);

		const broken = await respond({ baseURL: "https://dead.test/v1" });
		assert.equal(broken.ok, true);
		assert.equal(Array.isArray(broken.models), true);
	} finally {
		fetchStub.restore();
		ctx.dispose();
	}
});

test("settings changes re-arm the bridge live, without a re-apply", async () => {
	const llm = makeLlm(() => ["text"]);
	const ctx = makeCtx({ llm, services: { attachments: ATTACHMENTS } });
	assert.deepEqual((await llm.resolveModelInfo("oc", "m")).inputModalities, ["text"]);

	ctx.scope.set("baseURL", COMPLETE.baseURL);
	ctx.scope.set("model", COMPLETE.model);
	ctx.scope.set("apiKey", COMPLETE.apiKey);

	const forced = await llm.resolveModelInfo("oc", "m");
	assert.deepEqual([...forced.inputModalities], ["text", "image"]);

	ctx.scope.set("mode", "off");
	assert.deepEqual((await llm.resolveModelInfo("oc", "m")).inputModalities, ["text"]);
	ctx.dispose();
});

test("a provider that caps output tokens is retried with the cap it names", async () => {
	// glm-4v-flash rejects anything above 1024 with exactly this body.
	const ctx = makeCtx({ settings: { ...COMPLETE, maxTokens: 1200, cacheEnabled: false } });
	const listener = ctx.listeners.get("llm/stream")[0];
	const budgets = [];
	const fetchStub = stubFetch((_url, init) => {
		const body = JSON.parse(init.body);
		budgets.push(body.max_tokens);
		if (body.max_tokens > 1024) {
			return { status: 400, body: { error: { code: "1210", message: "max_tokens参数非法：限制数值范围[1,1024]" } } };
		}
		return { body: { choices: [{ message: { content: "图中是 Google 搜索首页" }, finish_reason: "stop" }] } };
	});
	try {
		const stream = listener({
			provider: "oc",
			model: "deepseek-v4.1-flash-free",
			messages: [{ role: "user", content: [{ type: "image", attachment: IMAGE }] }]
		}, () => {
			throw new Error("must not fall through");
		});
		for await (const _chunk of stream) {
			/* drain */
		}
		assert.deepEqual(budgets, [1200, 1024], "one rejection, one retry at the reported cap");
		const text = ctx.llm.streamed[0].messages[0].content[0].text;
		assert.match(text, /图中是 Google 搜索首页/u);
		assert.doesNotMatch(text, /转述失败/u);
		assert.equal(ctx.logs.some((entry) => entry.message.includes("自动夹取")), true);
	} finally {
		fetchStub.restore();
		ctx.dispose();
	}
});

test("a truncated transcription is continued instead of cut in half", async () => {
	const ctx = makeCtx({ settings: { ...COMPLETE, cacheEnabled: false } });
	const listener = ctx.listeners.get("llm/stream")[0];
	const bodies = [];
	const fetchStub = stubFetch((_url, init) => {
		const body = JSON.parse(init.body);
		bodies.push(body);
		if (bodies.length === 1) {
			return { body: { choices: [{ message: { content: "第一段：顶部导航栏" }, finish_reason: "length" }] } };
		}
		return { body: { choices: [{ message: { content: "第二段：搜索框与按钮" }, finish_reason: "stop" }] } };
	});
	try {
		const stream = listener({
			provider: "oc",
			model: "deepseek-v4.1-flash-free",
			messages: [{ role: "user", content: [{ type: "image", attachment: IMAGE }] }]
		}, () => {
			throw new Error("must not fall through");
		});
		for await (const _chunk of stream) {
			/* drain */
		}
		assert.equal(bodies.length, 2, "one call plus one continuation");
		assert.equal(bodies[1].messages.length, 3, "the continuation carries prompt, answer and a nudge");
		assert.equal(bodies[1].messages[1].role, "assistant");
		assert.match(bodies[1].messages[1].content, /第一段/u);
		assert.equal(bodies[1].messages[2].role, "user");
		const text = ctx.llm.streamed[0].messages[0].content[0].text;
		assert.match(text, /第一段：顶部导航栏/u);
		assert.match(text, /第二段：搜索框与按钮/u);
	} finally {
		fetchStub.restore();
		ctx.dispose();
	}
});
