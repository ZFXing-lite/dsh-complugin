/**
 * The updater's contract: it must never claim an update it cannot make, it must
 * degrade to "no-git" instead of throwing when git is unusable, and it must not
 * touch the network on `snapshot()`.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createUpdater, parseSlug } from "../lib/core/update.js";

const logger = { info: () => {}, warn: () => {}, error: () => {} };

test("parseSlug reads a package.json repository url and a git remote", () => {
	assert.equal(parseSlug("git+https://github.com/ZFXing-lite/dsh-complugin.git"), "ZFXing-lite/dsh-complugin");
	assert.equal(parseSlug("https://github.com/owner/repo"), "owner/repo");
	assert.equal(parseSlug("git@github.com:owner/repo.git"), "owner/repo");
	assert.equal(parseSlug("https://gitlab.com/owner/repo"), "", "a non-GitHub host has no slug");
	assert.equal(parseSlug(""), "");
	assert.equal(parseSlug(undefined), "");
});

test("snapshot starts unknown and never performs a check", () => {
	const updater = createUpdater({ logger, rootDir: tmpdir() });
	const snapshot = updater.snapshot();
	assert.equal(snapshot.state, "unknown");
	assert.equal(snapshot.behind, false);
	assert.deepEqual(snapshot.current, { version: "", commit: "" });
});

test("a directory that is not a checkout reports no-git instead of throwing", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "complugin-update-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");

	const updater = createUpdater({ logger, rootDir: dir });
	const state = await updater.check();
	assert.equal(state.state, "no-git");
	assert.equal(state.behind, false);
	assert.equal(state.current.version, "9.9.9", "the local version is still reported");
	assert.match(state.detail, /git/u, "the reason names git");

	const applied = await updater.apply();
	assert.equal(applied.ok, false, "applying without git cannot succeed");
	assert.equal(applied.detail, state.detail);
});
