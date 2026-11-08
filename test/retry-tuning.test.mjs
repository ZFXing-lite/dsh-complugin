/**
 * retry-tuning module tests.
 *
 * Locks the patch descriptor shape, the dynamic patch generation, and the
 * module declaration (fields, actions, defaults).
 *
 * Run: node --test
 */
import assert from "node:assert/strict";
import test from "node:test";

import { defineModule, defaultsFor, describeModule } from "../lib/core/registry.js";
import { definePatch } from "../lib/core/hostpatch.js";

// The module's default export is a defineModule result; import it to inspect.
const mod = (await import("../lib/modules/retry-tuning.js")).default;

test("retry-tuning module has the expected shape", () => {
	assert.equal(mod.id, "retryTuning");
	assert.equal(mod.title, "重试调整");
	assert.equal(mod.kind, "patch");
	assert.equal(mod.fields.length, 4, "four configurable parameters");
	assert.equal(mod.actions.length, 1, "one action: recheck");
	assert.equal(mod.actions[0].id, "recheck");
	assert.equal(mod.patch.id, "retry-tuning");
	assert.equal(mod.patch.package, "@deepseek-ai/dsh-llm");
	assert.equal(mod.patch.file, "lib/types/retry-policy.js");
});

test("retry-tuning defaults match DSH's built-in defaults", () => {
	const defaults = defaultsFor([mod]);
	const rt = defaults.retryTuning;
	assert.equal(rt.maxRetries, 5, "DSH default is 5 retries");
	assert.equal(rt.initialDelayMs, 500, "DSH default is 500ms initial delay");
	assert.equal(rt.maxDelayMs, 10000, "DSH default is 10s max delay");
	assert.equal(rt.jitterRatio, 0.1, "DSH default is 0.1 jitter");
});

test("retry-tuning patch targets the 4 DEFAULT constants", () => {
	const patch = mod.patch;
	assert.ok(patch.find.includes("DEFAULT_MAX_RETRIES = 5"), "find targets max retries");
	assert.ok(patch.find.includes("DEFAULT_INITIAL_DELAY_MS = 500"), "find targets initial delay");
	assert.ok(patch.find.includes("DEFAULT_MAX_DELAY_MS = 10_000"), "find targets max delay");
	assert.ok(patch.find.includes("DEFAULT_JITTER_RATIO = 0.1"), "find targets jitter");
	assert.ok(patch.marker.includes("dsh-complugin:retry-tuning"), "marker tags the patch");
	assert.ok(patch.replace.includes("DEFAULT_MAX_RETRIES = 5"), "default replace keeps 5");
});

test("retry-tuning describeModule serializes for the panel", () => {
	const described = describeModule(mod, { enabled: true });
	assert.equal(described.id, "retryTuning");
	assert.equal(described.title, "重试调整");
	assert.ok(described.fields.length === 4);
	assert.ok(described.actions.length === 1);
	assert.ok(described.patch !== null, "patch descriptor is exposed for the panel");
});

test("retry-tuning field ranges are sane", () => {
	const maxRetries = mod.fields.find((f) => f.key === "maxRetries");
	assert.equal(maxRetries.min, 0, "can disable retries entirely");
	assert.equal(maxRetries.max, 20, "but not infinite");

	const jitter = mod.fields.find((f) => f.key === "jitterRatio");
	assert.equal(jitter.min, 0);
	assert.equal(jitter.max, 1);

	const initialDelay = mod.fields.find((f) => f.key === "initialDelayMs");
	assert.ok(initialDelay.min >= 100, "at least 100ms");
	assert.ok(initialDelay.max <= 60000, "at most 60s");
});

test("safeConfig clamps maxDelayMs to initialDelayMs when it would be smaller", () => {
	// Import safeConfig indirectly via patchFactory — the clamped value should be used
	const patch = mod.patchFactory({ maxRetries: 3, initialDelayMs: 2000, maxDelayMs: 500, jitterRatio: 0.1 });
	// The replace text should contain maxDelayMs = 2000 (clamped up from 500)
	assert.ok(patch.replace.includes("DEFAULT_MAX_DELAY_MS = 2000"), "maxDelayMs clamped to initialDelayMs");
	assert.ok(patch.replace.includes("DEFAULT_INITIAL_DELAY_MS = 2000"), "initialDelayMs preserved");
});

test("safeConfig does not clamp when maxDelayMs >= initialDelayMs", () => {
	const patch = mod.patchFactory({ maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 });
	assert.ok(patch.replace.includes("DEFAULT_MAX_DELAY_MS = 10000"), "maxDelayMs not clamped");
	assert.ok(patch.replace.includes("DEFAULT_INITIAL_DELAY_MS = 500"), "initialDelayMs preserved");
});

test("safeConfig handles missing/junk values with fallbacks", () => {
	const patch = mod.patchFactory({});
	assert.ok(patch.replace.includes("DEFAULT_MAX_RETRIES = 5"), "default maxRetries");
	assert.ok(patch.replace.includes("DEFAULT_INITIAL_DELAY_MS = 500"), "default initialDelayMs");
	assert.ok(patch.replace.includes("DEFAULT_MAX_DELAY_MS = 10000"), "default maxDelayMs");
	assert.ok(patch.replace.includes("DEFAULT_JITTER_RATIO = 0.1"), "default jitterRatio");

	const patch2 = mod.patchFactory({ maxRetries: "abc", initialDelayMs: null, maxDelayMs: -1, jitterRatio: 99 });
	assert.ok(patch2.replace.includes("DEFAULT_MAX_RETRIES = 5"), "junk maxRetries -> default");
	assert.ok(patch2.replace.includes("DEFAULT_INITIAL_DELAY_MS = 500"), "null initialDelayMs -> default");
	assert.ok(patch2.replace.includes("DEFAULT_MAX_DELAY_MS = 10000"), "negative maxDelayMs -> default 10000 (>= initialDelayMs, no clamp)");
	assert.ok(patch2.replace.includes("DEFAULT_JITTER_RATIO = 0.1"), "out-of-range jitter -> default");
});
