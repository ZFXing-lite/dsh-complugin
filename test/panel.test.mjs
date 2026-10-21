/**
 * Panel API integration tests.
 *
 * Applies the real host entry to a mock cordis context and drives the five
 * HTTP routes the browser half talks to. This is the seam that must stay
 * stable when a new module is added: the panel is generic, so a broken
 * status payload breaks every card at once.
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "complugin-home-"));

const { apply, name, inject } = await import("../lib/index.js");

/** LlmRuntime-shaped stand-in: the vision module wraps a prototype method. */
class LlmRuntime {
	async resolveModelInfo(provider, model) {
		return { provider, model, inputModalities: ["text"] };
	}
	stream() {
		return (async function* empty() {})();
	}
}

/** Build a mock host and return the mounted routes plus the live settings doc. */
function makeHost(options = {}) {
	const logs = [];
	const routes = new Map();
	const disposers = [];
	const watchers = new Set();
	const document = { enabled: true, modules: {} };
	const llm = options.llm ?? new LlmRuntime();

	const record = (level) => (message) => logs.push({ level, message: String(message) });

	const scope = {
		get: () => document,
		watch: (callback) => {
			watchers.add(callback);
			return () => watchers.delete(callback);
		},
		update: async (patch) => {
			Object.assign(document, patch);
			for (const callback of watchers) callback();
		},
		replace: async (next) => {
			Object.assign(document, next);
			for (const callback of watchers) callback();
		}
	};

	const services = {
		settings: { register: () => scope },
		agents: { roots: () => [], get: () => undefined },
		webServer: {
			register: (route) => {
				routes.set(route.path, route.handler);
				return () => routes.delete(route.path);
			}
		},
		attachments: { readImageRequest: async () => ({ data: Buffer.from([1]), mediaType: "image/png" }) }
	};

	const ctx = {
		logger: { info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") },
		llm,
		settings: services.settings,
		inject: (names, callback) => {
			const service = services[names[0]];
			if (service === undefined) return () => false;
			callback({ [names[0]]: service });
			return () => true;
		},
		on: () => () => true,
		effect: (execute) => {
			const result = execute();
			if (typeof result === "function") disposers.push(result);
			else if (result !== null && typeof result === "object" && Symbol.iterator in result) {
				const iterator = result[Symbol.iterator]();
				while (true) {
					const step = iterator.next();
					if (typeof step.value === "function") disposers.push(step.value);
					if (step.done) break;
				}
			}
			return () => {};
		}
	};

	apply(ctx, options.row ?? {});

	/** Invoke one route and capture its JSON payload. */
	async function call(routePath, body) {
		const handler = routes.get(routePath);
		assert.equal(typeof handler, "function", `route ${routePath} must be mounted`);
		const captured = { status: 0, payload: undefined };
		const res = {
			writeHead(status) {
				captured.status = status;
			},
			end(text) {
				captured.payload = JSON.parse(text);
			}
		};
		const req = body === undefined
			? { method: "GET" }
			: {
				method: "POST",
				async *[Symbol.asyncIterator]() {
					yield Buffer.from(JSON.stringify(body));
				}
			};
		await handler(req, res);
		return captured;
	}

	return {
		logs,
		routes,
		document,
		call,
		dispose: () => {
			for (const fn of disposers) fn();
		}
	};
}

test("the plugin declares the host services it needs", () => {
	assert.equal(name, "complugin");
	assert.deepEqual([...inject], ["agents", "llm"]);
});

test("status describes every module, in panel order, with drawable fields", async () => {
	const host = makeHost();
	const { status, payload } = await host.call("/api/complugin/status");
	assert.equal(status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.plugin.name, "complugin");
	assert.equal(payload.namespace, "complugin");
	assert.deepEqual(payload.modules.map((module) => module.id), ["autoCompact", "autoContinue", "visionBridge", "reasoningEffort"]);
	for (const module of payload.modules) {
		assert.equal(typeof module.title, "string");
		assert.ok(module.fields.length > 0, `${module.id} must expose fields`);
		for (const field of module.fields) {
			assert.ok(["switch", "number", "text", "secret", "textarea", "select", "multi"].includes(field.type));
			assert.ok(["basic", "tuning", "advanced"].includes(field.group));
			assert.equal(typeof field.default !== "undefined" || field.type === "secret" || field.type === "text", true);
		}
	}
	const vision = payload.modules.find((module) => module.id === "visionBridge");
	assert.deepEqual(vision.actions.map((action) => action.id), ["models", "test", "saveKey", "clearCache"]);
	assert.equal(vision.actions.find((action) => action.id === "models").route, "/api/complugin/vision/models");
	const reasoning = payload.modules.find((module) => module.id === "reasoningEffort");
	assert.equal(reasoning.patch.id, "reasoning-effort");
	assert.equal(reasoning.patch.find, undefined, "the panel never receives the patch source");
	host.dispose();
});

test("config writes reach the settings document and are normalized", async () => {
	const host = makeHost();
	const { payload } = await host.call("/api/complugin/config", { module: "autoCompact", values: { readyRatio: 0.7, enabled: true } });
	assert.equal(payload.ok, true);
	assert.equal(host.document.modules.autoCompact.readyRatio, 0.7);
	assert.equal(host.document.modules.autoCompact.enabled, true);
	assert.equal(host.document.modules.autoCompact.forceRatio, 0.85, "untouched fields keep their default");
	assert.equal(typeof payload.detail, "string");

	const coerced = await host.call("/api/complugin/config", { module: "autoCompact", values: { readyRatio: 42 } });
	assert.equal(coerced.payload.ok, true);
	assert.equal(host.document.modules.autoCompact.readyRatio, 1, "out-of-range input is clamped to the field max, not stored");

	const unknown = await host.call("/api/complugin/config", { module: "nope", values: { x: 1 } });
	assert.equal(unknown.payload.ok, false);
	assert.match(unknown.payload.detail, /未知模块/u);
	host.dispose();
});

test("the master switch turns the whole panel off without losing module values", async () => {
	const host = makeHost();
	await host.call("/api/complugin/config", { module: "autoCompact", values: { readyRatio: 0.6 } });
	const { payload } = await host.call("/api/complugin/master", { enabled: false });
	assert.equal(payload.ok, true);
	assert.equal(payload.plugin.enabled, false);
	assert.equal(host.document.modules.autoCompact.readyRatio, 0.6, "values survive the switch");
	assert.equal(payload.modules.every((module) => module.status.ready === false), true);

	const back = await host.call("/api/complugin/master", { enabled: true });
	assert.equal(back.payload.plugin.enabled, true);
	assert.equal(back.payload.modules.find((module) => module.id === "autoCompact").status.ready, true);
	host.dispose();
});

test("action runs a module handler and reports an unknown one honestly", async () => {
	const host = makeHost();
	const ok = await host.call("/api/complugin/action", { module: "reasoningEffort", action: "recheck" });
	assert.equal(ok.payload.ok, true);
	assert.match(ok.payload.detail, /接管|关闭|未生效/u);

	const missing = await host.call("/api/complugin/action", { module: "visionBridge", action: "launchMissiles" });
	assert.equal(missing.payload.ok, false);
	assert.match(missing.payload.detail, /没有动作/u);
	host.dispose();
});

test("patch status is readable through the panel and never edits a file on status", async () => {
	const host = makeHost();
	const { payload } = await host.call("/api/complugin/patch", { module: "reasoningEffort", action: "status" });
	assert.equal(payload.ok, true);
	const module = payload.modules.find((entry) => entry.id === "reasoningEffort");
	assert.ok(["applied", "clean", "missing", "conflict"].includes(module.status.patch.state));
	assert.equal(typeof module.status.patch.detail, "string");
	host.dispose();
});

test("teardown removes every route and leaves no listener behind", async () => {
	const host = makeHost();
	assert.equal(host.routes.size >= 5, true);
	host.dispose();
	assert.equal(host.routes.size, 0);
});
