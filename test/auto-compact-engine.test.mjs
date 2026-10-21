/**
 * Decision-engine unit tests for dsh-auto-compact.
 *
 * Runs on plain node: `node test/engine.test.mjs`
 * Imports the pure `decide`/`freshState` exports from the host half; no dsh
 * runtime needed.
 */
import assert from "node:assert/strict";
import { decide, freshState, DEFAULTS } from "../lib/modules/auto-compact.js";

let passed = 0;
function check(name, fn) {
	try {
		fn();
		passed += 1;
		console.log(`ok - ${name}`);
	} catch (error) {
		console.error(`not ok - ${name}`);
		console.error(error);
		process.exitCode = 1;
	}
}

const config = { ...DEFAULTS };
const NOW = 1_000_000;

check("disabled master switch stays idle", () => {
	const state = freshState();
	const d = decide(190_000, 200_000, { ...config, enabled: false }, state, NOW);
	assert.equal(d.kind, "idle");
	assert.equal(d.updatedReady, false);
});

check("unknown capacity (0) stays idle", () => {
	const state = freshState();
	const d = decide(190_000, 0, config, state, NOW);
	assert.equal(d.kind, "idle");
});

check("below ready threshold is idle and clears ready", () => {
	const state = freshState();
	state.ready = true;
	const d = decide(100_000, 200_000, config, state, NOW);
	assert.equal(d.kind, "idle");
	assert.equal(d.updatedReady, false);
});

check("ready band (>=80%) reports ready", () => {
	const state = freshState();
	const d = decide(160_000, 200_000, config, state, NOW);
	assert.equal(d.kind, "ready");
	assert.equal(d.updatedReady, true);
});

check("force band (>=85%) reports force", () => {
	const state = freshState();
	const d = decide(170_000, 200_000, config, state, NOW);
	assert.equal(d.kind, "force");
	assert.equal(d.updatedReady, true);
});

check("exact force boundary triggers force", () => {
	const state = freshState();
	// 200000 * .85 = 170000 exactly
	const d = decide(170_000, 200_000, config, state, NOW);
	assert.equal(d.kind, "force");
});

check("exact ready boundary triggers ready, not force", () => {
	const state = freshState();
	// 200000 * .8 = 160000 exactly
	const d = decide(160_000, 200_000, config, state, NOW);
	assert.equal(d.kind, "ready");
});

check("force inside cooldown window reports cooldown", () => {
	const state = freshState();
	state.lastForceTs = NOW - 1000; // 1s ago < 30000ms
	const d = decide(190_000, 200_000, config, state, NOW);
	assert.equal(d.kind, "cooldown");
});

check("force after cooldown elapses reports force", () => {
	const state = freshState();
	state.lastForceTs = NOW - 30_001; // just past the interval
	const d = decide(190_000, 200_000, config, state, NOW);
	assert.equal(d.kind, "force");
});

check("zero cooldown interval never blocks", () => {
	const state = freshState();
	state.lastForceTs = NOW; // same instant
	const d = decide(190_000, 200_000, { ...config, minIntervalMs: 0 }, state, NOW);
	assert.equal(d.kind, "force");
});

check("custom thresholds shift the bands", () => {
	const custom = { ...config, readyRatio: 0.9, forceRatio: 0.95 };
	assert.equal(decide(180_000, 200_000, custom, freshState(), NOW).kind, "ready");
	assert.equal(decide(190_000, 200_000, custom, freshState(), NOW).kind, "force");
	assert.equal(decide(170_000, 200_000, custom, freshState(), NOW).kind, "idle");
});

check("freshState carries the documented fields", () => {
	const state = freshState();
	assert.equal(state.ready, false);
	assert.equal(state.lastForceTs, 0);
	assert.equal(state.warnedNoCapacity, false);
});

check("DEFAULTS match the shipped patch row", () => {
	assert.equal(DEFAULTS.enabled, true);
	assert.equal(DEFAULTS.contextWindowTokens, 0);
	assert.equal(DEFAULTS.readyRatio, 0.8);
	assert.equal(DEFAULTS.forceRatio, 0.85);
	assert.equal(DEFAULTS.includeSubagents, false);
	assert.equal(DEFAULTS.notify, true);
	assert.equal(DEFAULTS.minIntervalMs, 30000);
});

console.log(`\n${passed} assertions passed`);
