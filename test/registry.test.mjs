/**
 * Field/registry/patch/lagacy unit tests.
 *
 * These lock the contract a future module depends on: one field spec in, one
 * panel control out, and a settings value that survives a hand-edited YAML.
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { coerceValue, defineField, describeFields, normalizeFields } from "../lib/core/fields.js";
import { defaultsFor, defineModule, defineModules, describeModule, normalizeConfig } from "../lib/core/registry.js";
import { createHostPatcher, definePatch } from "../lib/core/hostpatch.js";
import { parseSettingsBlocks } from "../lib/core/legacy.js";
import { shouldAugment, thinkingMapOf } from "../lib/modules/reasoning-effort.js";

test("defineField rejects a control it cannot draw and keeps a good one frozen", () => {
	assert.throws(() => defineField({ key: "x", label: "X", type: "color" }), /type 非法/u);
	assert.throws(() => defineField({ key: "1x", label: "X", type: "text" }), /key 非法/u);
	const field = defineField({ key: "ratio", label: "比例", type: "number", default: 2, min: 0, max: 1, step: 0.01 });
	assert.equal(field.default, 1, "an out-of-range default is clamped, not trusted");
	assert.equal(Object.isFrozen(field), true);
});

test("coerceValue survives every kind of junk a settings file can hold", () => {
	const flag = defineField({ key: "on", label: "开", type: "switch", default: false });
	assert.equal(coerceValue(flag, "true").value, true);
	assert.equal(coerceValue(flag, 1).value, true);
	assert.equal(coerceValue(flag, "nonsense").value, false);
	assert.equal(coerceValue(flag, "nonsense").problem, "期望 true/false");

	const tokens = defineField({ key: "n", label: "数字", type: "number", default: 100, min: 1, max: 200, step: 1 });
	assert.deepEqual(coerceValue(tokens, "150"), { value: 150, problem: null });
	assert.deepEqual(coerceValue(tokens, 900), { value: 200, problem: "已夹取到 200" });
	assert.equal(coerceValue(tokens, "abc").value, 100);

	const mode = defineField({ key: "m", label: "模式", type: "select", default: "b", options: [{ value: "a" }, { value: "b" }] });
	assert.equal(coerceValue(mode, "a").value, "a");
	assert.deepEqual(coerceValue(mode, "zzz"), { value: "b", problem: "未知取值 zzz" });

	const levels = defineField({ key: "l", label: "档位", type: "multi", default: ["low"], options: [{ value: "low" }, { value: "high" }] });
	assert.deepEqual(coerceValue(levels, ["high", "high", "wat"]).value, ["high"]);
	assert.deepEqual(coerceValue(levels, ["high", "high", "wat"]).problem, "已丢弃非法选项");
});

test("normalizeFields fills every field and reports what it had to fix", () => {
	const fields = [
		defineField({ key: "a", label: "A", type: "switch", default: true }),
		defineField({ key: "b", label: "B", type: "number", default: 5, min: 0, max: 10, step: 1 })
	];
	const clean = normalizeFields(fields, { a: false });
	assert.deepEqual(clean.value, { a: false, b: 5 });
	assert.deepEqual(clean.problems, []);
	const messy = normalizeFields(fields, { a: "maybe", b: 99 });
	assert.equal(messy.value.b, 10);
	assert.equal(messy.problems.length, 2);
});

test("describeFields never ships a stored secret to the browser", () => {
	const fields = [defineField({ key: "apiKey", label: "密钥", type: "secret", default: "" })];
	const described = describeFields(fields, { apiKey: "your_api_key" });
	assert.equal(described[0].value, "");
	assert.equal(described[0].present, true);
});

test("defineModule validates a declaration and rejects a duplicate field", () => {
	const mount = () => ({});
	assert.throws(() => defineModule({ id: "bad id", title: "T", fields: [], mount }), /id 非法/u);
	assert.throws(() => defineModule({ id: "ok", title: "", fields: [], mount }), /缺少 title/u);
	assert.throws(() => defineModule({ id: "ok", title: "T", fields: [], mount: undefined }), /缺少 mount/u);
	assert.throws(() => defineModule({
		id: "ok",
		title: "T",
		fields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "A2", type: "text" }],
		mount
	}), /字段 a 重复/u);
	const module = defineModule({ id: "ok", title: "T", order: 7, fields: [], mount });
	assert.equal(module.order, 7);
	assert.equal(module.kind, "hook");
});

test("defineModules orders the panel and refuses duplicate ids", () => {
	const mount = () => ({});
	const modules = defineModules([
		{ id: "second", title: "二", order: 20, fields: [], mount },
		{ id: "first", title: "一", order: 10, fields: [], mount }
	]);
	assert.deepEqual(modules.map((module) => module.id), ["first", "second"]);
	assert.throws(() => defineModules([
		{ id: "same", title: "A", fields: [], mount },
		{ id: "same", title: "B", fields: [], mount }
	]), /id 重复/u);
});

test("normalizeConfig ignores a module that no longer exists and defaults the master switch", () => {
	const modules = defineModules([
		{ id: "keep", title: "留", fields: [{ key: "n", label: "N", type: "number", default: 1, min: 0, max: 5, step: 1 }], mount: () => ({}) }
	]);
	const value = normalizeConfig(modules, { modules: { keep: { n: 3 }, gone: { n: 9 } } });
	assert.deepEqual(value.modules, { keep: { n: 3 } });
	assert.equal(value.enabled, true);
	assert.equal(normalizeConfig(modules, undefined).modules.keep.n, 1);
	assert.deepEqual(defaultsFor(modules), { keep: { n: 1 } });
});

test("describeModule carries the patch descriptor without leaking the edit strings", () => {
	const module = defineModule({
		id: "patched",
		title: "带补丁",
		fields: [],
		mount: () => ({}),
		patch: definePatch({ id: "p", label: "L", package: "@x/y", file: "lib/i.js", find: "OLD", replace: "NEW" })
	});
	const described = describeModule(module, { values: {}, status: { ready: true } });
	assert.equal(described.patch.id, "p");
	assert.equal(described.patch.find, undefined);
	assert.equal(described.status.ready, true);
});

test("legacy blocks are read as a flat, comment-tolerant map", () => {
	const text = [
		"# 顶层注释",
		"vision-bridge:",
		"  mode: auto",
		'  baseURL: "https://example.test/v1"   # 行尾注释',
		"  apiKey: ''",
		"  maxTokens: 1024",
		"  cacheEnabled: false",
		"unrelated:",
		"  keep: yes",
		"agents:",
		"  root: C:/work"
	].join("\n");
	const blocks = parseSettingsBlocks(text);
	assert.equal(blocks["vision-bridge"].mode, "auto");
	assert.equal(blocks["vision-bridge"].baseURL, "https://example.test/v1");
	assert.equal(blocks["vision-bridge"].apiKey, "");
	assert.equal(blocks["vision-bridge"].maxTokens, 1024);
	assert.equal(blocks["vision-bridge"].cacheEnabled, false);
	assert.equal(blocks.unrelated.keep, "yes");
});

test("hostpatch applies and reverts one literal, and refuses an ambiguous anchor", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "complugin-patch-"));
	const file = path.join(root, "target.js");
	const original = "function f() {\n\tif (x === void 0) return { a: 1 };\n}\n";
	fs.writeFileSync(file, original, "utf8");
	const logger = { info: () => {}, warn: () => {} };
	const patcher = createHostPatcher({ logger, backupRoot: path.join(root, "backups") });
	const descriptor = definePatch({
		id: "unit",
		label: "单元",
		package: "@test/none",
		file: "target.js",
		find: "if (x === void 0) return { a: 1 };",
		replace: "if (x === void 0) {\n\t\treturn { a: 2, marker: true };\n\t}",
		marker: "marker: true",
		absolute: file
	});

	assert.equal((await patcher.status(descriptor)).state, "clean");
	const applied = await patcher.apply(descriptor);
	assert.equal(applied.ok, true);
	assert.match(fs.readFileSync(file, "utf8"), /marker: true/u);
	assert.equal((await patcher.status(descriptor)).state, "applied");

	const again = await patcher.apply(descriptor);
	assert.equal(again.ok, true, "applying twice is a no-op, not an error");

	const reverted = await patcher.revert(descriptor);
	assert.equal(reverted.ok, true);
	assert.equal(fs.readFileSync(file, "utf8"), original);

	fs.writeFileSync(file, "if (x === void 0) return { a: 1 };\nif (x === void 0) return { a: 1 };\n", "utf8");
	const conflict = await patcher.status(descriptor);
	assert.equal(conflict.state, "conflict");
	const refused = await patcher.apply(descriptor);
	assert.equal(refused.ok, false);
	assert.match(refused.detail, /锚点不唯一/u);
	fs.rmSync(root, { recursive: true, force: true });
});

test("reasoning helpers only touch models that declared nothing", () => {
	assert.equal(shouldAugment({ id: "m" }), true);
	assert.equal(shouldAugment({ id: "m", reasoning: false }), false, "an explicit opt-out is respected");
	assert.equal(shouldAugment({ id: "m", reasoning: true }), false);
	assert.equal(shouldAugment(null), false);
	assert.deepEqual(thinkingMapOf(["low", "high"]), {
		off: null,
		minimal: null,
		xhigh: null,
		max: null,
		low: "low",
		high: "high"
	});
	assert.deepEqual(thinkingMapOf([]), thinkingMapOf(["low", "medium", "high"]), "an empty selection means every level");
	assert.deepEqual(thinkingMapOf(["bogus"]), thinkingMapOf(["low", "medium", "high"]));
});
