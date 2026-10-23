/**
 * Client bundle smoke test.
 *
 * Loads `lib/client.js` the way `window.__ModuleLoader__` does, runs the
 * factory against a minimal React shim, then renders the registered panel
 * component once and walks the returned tree. No browser, no network: the
 * point is that the bundle parses, exports the right shape, injects its CSS,
 * registers on the right slot key, and renders a titled panel.
 *
 * `node test/client.smoke.mjs`
 */
import assert from "node:assert/strict";

let registered = null;
const loaded = [];
const styleTags = [];
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loaded.push(definition.id);
			registered = definition;
		}
	}
};
globalThis.document = {
	querySelector: () => null,
	createElement: () => {
		const tag = { dataset: {}, style: {}, textContent: "", appendChild() {} };
		styleTags.push(tag);
		return tag;
	},
	head: { appendChild() {} }
};

await import(new URL("../lib/client.js", import.meta.url).href);

assert.equal(loaded.length, 1, "exactly one module load");
assert.equal(loaded[0], "dsh-complugin", "module id matches package");
assert.equal(typeof registered.factory, "function", "factory is a function");

const reactStub = {
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: (fn) => fn(),
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
};

const moduleExports = registered.factory((id) => {
	if (id === "react") return reactStub;
	throw new Error(`unexpected require: ${id}`);
});

assert.equal(typeof moduleExports.apply, "function", "exports.apply is a function");
assert.deepEqual(moduleExports.inject, ["slots"], "exports.inject lists the client services");
assert.equal(styleTags.length, 1, "the panel ships exactly one stylesheet");
assert.match(styleTags[0].textContent, /\.cp_root/u, "the stylesheet carries the panel rules");
assert.equal(styleTags[0].dataset.pluginCss, "dsh-complugin/panel.css");

// Drive apply() against a slot stub and capture what it registers.
let registration = null;
const cleanups = [];
const ctx = {
	slots: {
		inject: (name, thunk) => {
			assert.equal(name, "settings.plugins.tab");
			thunk();
		},
		register: (spec, component) => {
			registration = { spec, component };
			return () => {};
		}
	},
	effect: (fn) => {
		const cleanup = fn();
		if (typeof cleanup === "function") cleanups.push(cleanup);
	}
};
moduleExports.apply(ctx);

assert.ok(registration, "the panel registers into settings.plugins.tab");
assert.equal(registration.spec.id, "complugin", "the tab is keyed by the complugin namespace");
assert.equal(registration.spec.order, 1, "the tab sits right after 插件配置 (order 0) and before 插件列表 (order 10)");
assert.equal(registration.spec.label(), "功能补全", "the tab carries a short label");
assert.equal(typeof registration.component, "function", "the registered value is a component");

// Render once with a synthesized status payload and inspect the tree.
const injected = registration.spec.inject();
const payload = {
	ok: true,
	plugin: { name: "complugin", version: "1.0.0", enabled: true },
	namespace: "complugin",
	modules: [
		{
			id: "autoCompact", title: "自动压缩", summary: "上下文压力自动压缩", kind: "hook", legacy: "auto-compact",
			docs: "", patch: null, enabled: true,
			fields: [{ key: "enabled", label: "启用", type: "switch", group: "basic", default: true, value: true, hint: "总开关" }],
			actions: [],
			status: { ready: true, sign: "on", badge: "运行中", line: "阈值 0.8 / 0.85", entries: [], stats: [{ label: "压缩", value: 2 }], patch: null }
		},
		{
			id: "reasoningEffort", title: "推理等级", summary: "档位可选", kind: "hook", legacy: "", docs: "", enabled: true,
			patch: { id: "reasoning-effort", label: "推理等级默认可见（文件补丁）", note: "可选", package: "@deepseek-ai/dsh-llm-pi-ai", file: "lib/index.js" },
			fields: [{ key: "mode", label: "接管方式", type: "select", group: "basic", default: "wrap", value: "wrap", options: [{ value: "wrap", label: "运行时接管" }] }],
			actions: [{ id: "recheck", label: "重新检测", needs: [] }],
			status: { ready: true, sign: "on", badge: "接管中", line: "运行时就绪", entries: [{ level: "info", text: "已接管" }], stats: [], patch: { id: "reasoning-effort", state: "clean", detail: "未应用" } }
		},
		{
			id: "visionBridge", title: "视觉桥", summary: "文本模型看图", kind: "hook", legacy: "vision-bridge", docs: "", enabled: true, patch: null,
			fields: [{ key: "model", label: "视觉模型", type: "text", group: "basic", default: "", value: "", hint: "" }],
			actions: [
				{ id: "models", label: "拉取模型", needs: [], route: "/api/complugin/vision/models", resultField: "model" },
				{ id: "test", label: "测试视觉", needs: [], route: "/api/complugin/vision/test" }
			],
			status: { ready: false, sign: "warn", badge: "未就绪", line: "缺项：apiKey", entries: [], stats: [], patch: null }
		}
	]
};
injected.store.set({
	loading: false, error: "", data: payload, updatedAt: Date.now(),
	drafts: {}, busy: {}, notices: {}, results: {}, open: null
});

const tree = registration.component(injected);

/** Collect every string in a rendered tree. */
function texts(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) texts(child, out);
		return out;
	}
	if (typeof node === "object") {
		if (typeof node.type === "function") {
			texts(node.type(node.props ?? {}), out);
			return out;
		}
		if (node.props) {
			for (const [key, value] of Object.entries(node.props)) {
				if (key === "children" || key === "title" || key === "placeholder" || key === "key") continue;
				if (typeof value === "string" || typeof value === "number") out.push(String(value));
			}
		}
		texts(node.children ?? [], out);
	}
	return out;
}

const flat = texts(tree).join(" | ");
assert.match(flat, /DSH功能补全插件/u, "the panel is titled DSH功能补全插件");
assert.match(flat, /自动压缩/u, "module cards come from the status payload");
assert.match(flat, /推理等级/u, "a second module renders from the same generic renderer");
assert.match(flat, /含补丁/u, "a module that declares a patch is flagged in the header");
assert.match(flat, /2 个模块就绪|2\b/u, "the summary chips count ready modules");
// The tab must start short: no card auto-opens, so no field markup is on screen.
assert.doesNotMatch(flat, /启用/u, "cards start collapsed — field labels are not rendered");
assert.doesNotMatch(flat, /文件补丁/u, "the patch block only renders inside an open card");

// Opening a card reveals its basic group…
injected.toggleModule("autoCompact");
const flatOpen = texts(registration.component(injected)).join(" | ");
assert.match(flatOpen, /启用/u, "the open card renders its basic fields");
assert.match(flatOpen, /基础/u, "the field groups render as collapsible heads");

// …and the accordion closes the previous card, keeping the tab short.
injected.toggleModule("reasoningEffort");
const flatAccordion = texts(registration.component(injected)).join(" | ");
assert.match(flatAccordion, /文件补丁/u, "the open card renders its patch block");
assert.match(flatAccordion, /回滚/u, "the patch block offers apply and revert");
assert.match(flatAccordion, /重新检测/u, "the patch block offers a re-check");
assert.doesNotMatch(flatAccordion, /启用/u, "the previously open card closed (accordion)");

// Action outcomes persist and render: model chips + transcription text.
injected.setResult("visionBridge:models", {
	ok: true,
	detail: "拉到 2 个模型",
	data: { models: [{ id: "glm-4v-flash", ownedBy: "zhipu" }, { id: "glm-4v-plus", ownedBy: "zhipu" }] }
});
injected.setResult("visionBridge:test", { ok: true, detail: "glm-4v-flash 用时 5 ms", data: { text: "蓝色", ms: 5 } });
injected.toggleModule("visionBridge");
const flatResults = texts(registration.component(injected)).join(" | ");
assert.match(flatResults, /glm-4v-flash/u, "拉取模型 renders the returned models");
assert.match(flatResults, /点模型名就填进/u, "the chips explain they pick the model for you");
assert.match(flatResults, /蓝色/u, "测试视觉 shows the transcription text");
assert.match(flatResults, /5 ms/u, "测试视觉 shows the timing");

// Dismissing an outcome removes it without touching the other.
injected.clearResult("visionBridge:test");
const flatDismissed = texts(registration.component(injected)).join(" | ");
assert.doesNotMatch(flatDismissed, /蓝色/u, "dismissing removes one outcome");
assert.match(flatDismissed, /glm-4v-flash/u, "the other outcome stays");

for (const cleanup of cleanups) cleanup();

// ── regression: the injected API must carry the value resolvers ──────────────
// Without these the renderer falls through to `Object.prototype.valueOf`, every
// control receives an object, and the whole panel renders inert (switches stuck
// grey, inputs rejected) while the master switch keeps working — the exact
// symptom that shipped in 1.0.0.
assert.equal(typeof injected.valueOf, "function", "the injected API resolves field values");
assert.equal(typeof injected.effectiveValues, "function", "the injected API resolves whole-module values");
assert.equal(typeof injected.checkUpdate, "function", "the injected API can check for updates");
assert.equal(typeof injected.applyUpdate, "function", "the injected API can apply an update");

injected.store.set({
	loading: false, error: "", data: payload, updatedAt: Date.now(),
	drafts: {}, busy: {}, notices: {}, results: {}, open: null
});
const module = payload.modules[0];
const field = module.fields[0];
assert.equal(injected.valueOf(module, field), true, "an untouched field reads its stored value");
injected.setField(module.id, field.key, false);
assert.equal(injected.valueOf(module, field), false, "a staged draft wins over the stored value");
assert.deepEqual(injected.effectiveValues(module), { enabled: false }, "action payloads see the draft too");

console.log("ok - client bundle loads, registers its slot, and renders the merged panel");
