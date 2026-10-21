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
		inject: (name, generator) => {
			assert.equal(name, "settings.plugin.item");
			generator().next();
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

assert.ok(registration, "the panel registers into settings.plugin.item");
assert.equal(registration.spec.key, "complugin", "registered under the complugin namespace");
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
		}
	]
};
injected.store.set({
	loading: false, error: "", data: payload, updatedAt: Date.now(), drafts: {}, busy: {}, notices: {}
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

// The first card opens by default; reverse the array so the patch block renders too.
injected.store.set({
	loading: false, error: "", data: { ...payload, modules: [...payload.modules].reverse() },
	updatedAt: Date.now(), drafts: {}, busy: {}, notices: {}
});
const flatReversed = texts(registration.component(injected)).join(" | ");
assert.match(flatReversed, /文件补丁/u, "the patch block renders for a module that declares one");
assert.match(flatReversed, /回滚/u, "the patch block offers apply and revert");
assert.match(flatReversed, /重新检测/u, "the patch block offers a re-check");

for (const cleanup of cleanups) cleanup();
console.log("ok - client bundle loads, registers its slot, and renders the merged panel");
