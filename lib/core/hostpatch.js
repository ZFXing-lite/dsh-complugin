/**
 * dsh-complugin — the host-patch service.
 *
 * Some wishes cannot be granted from a cordis hook: the behaviour lives in a
 * private function inside a DSH package. The classic answer is a shell script
 * that string-replaces the installed file, which works until the next
 * `npm i -g`, and then fails in a way nobody notices.
 *
 * This service keeps that idea but makes it a first-class, reversible, visible
 * operation:
 *
 * 1. a patch is a **declaration** — target package, file, one exact literal and
 *    its replacement, plus a marker that proves the patch is in place;
 * 2. `apply` verifies the literal occurs exactly once (no silent partial
 *    match), backs the file up under `$DSH_HOME/complugin/backups/`, writes,
 *    and re-reads to confirm;
 * 3. `revert` reverses the literal, or restores the newest backup when the file
 *    no longer matches the patched shape;
 * 4. `status` reports per-target state, so the panel can show 「已打 / 未打 /
 *    版本已变」 instead of guessing.
 *
 * A future patch module only has to declare a descriptor and call this service —
 * no new plumbing.
 *
 * @module dsh-complugin/core/hostpatch
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderThrown } from "./env.js";

/** How many backups per patch id are kept. */
const KEEP_BACKUPS = 5;

/**
 * Locate a DSH package directory.
 *
 * Resolution order: through this module's own `node_modules` (which the install
 * step links at DSH's `@deepseek-ai` folder), then the common global install
 * roots. Returns undefined when nothing matches.
 *
 * @param {string} packageName - e.g. `@deepseek-ai/dsh-llm-pi-ai`.
 * @returns {Promise<string|undefined>} absolute package directory.
 */
async function resolvePackageDir(packageName) {
	const candidates = [];
	try {
		const viaImport = import.meta.resolve(`${packageName}/package.json`);
		if (typeof viaImport === "string" && viaImport.startsWith("file:")) candidates.push(path.dirname(fileURLToPath(viaImport)));
	} catch {
		/* not resolvable from here; fall through to the filesystem guesses */
	}
	const scoped = packageName.split("/");
	const joined = scoped.join(path.sep);
	const roots = [
		process.env.APPDATA === undefined ? "" : path.join(process.env.APPDATA, "npm", "node_modules"),
		path.join(process.execPath, "..", "node_modules"),
		path.join(path.dirname(process.execPath), "node_modules")
	].filter((root) => root !== "");
	for (const root of roots) {
		candidates.push(path.join(root, joined));
		candidates.push(path.join(root, "@deepseek-ai", "dsh", "node_modules", joined));
	}
	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(path.join(candidate, "package.json"));
			if (stat.isFile()) return candidate;
		} catch {
			/* keep looking */
		}
	}
	return undefined;
}

/**
 * Create the patch service.
 *
 * @param {object} options - `{ logger, backupRoot }`.
 * @returns {object} the service.
 */
export function createHostPatcher(options) {
	const logger = options?.logger;
	const backupRoot = String(options?.backupRoot ?? "");
	/** descriptor id → absolute target path, once resolved. */
	const resolved = new Map();

	/** Resolve (and cache) the absolute file a descriptor points at. */
	async function targetOf(descriptor) {
		const key = descriptor.id;
		if (resolved.has(key)) return resolved.get(key);
		if (typeof descriptor.absolute === "string" && descriptor.absolute !== "") {
			resolved.set(key, descriptor.absolute);
			return descriptor.absolute;
		}
		const dir = await resolvePackageDir(descriptor.package);
		if (dir === undefined) return undefined;
		const file = path.join(dir, descriptor.file);
		resolved.set(key, file);
		return file;
	}

	/** Whether the marker is present in the given text. */
	const marked = (descriptor, text) => typeof descriptor.marker === "string" && descriptor.marker !== "" && text.includes(descriptor.marker);
	/** Whether the exact original literal is present. */
	const original = (descriptor, text) => occurrenceCount(text, descriptor.find) === 1;
	/** Whether the exact patched literal is present. */
	const patched = (descriptor, text) => occurrenceCount(text, descriptor.replace) === 1;

	/** Count non-overlapping occurrences. */
	function occurrenceCount(text, needle) {
		if (typeof needle !== "string" || needle === "") return 0;
		let count = 0;
		let index = text.indexOf(needle);
		while (index !== -1) {
			count += 1;
			index = text.indexOf(needle, index + needle.length);
		}
		return count;
	}

	/** Read the target file, or undefined when it cannot be resolved. */
	async function read(descriptor) {
		const file = await targetOf(descriptor);
		if (file === undefined) return { file: undefined, text: undefined };
		try {
			return { file, text: await fs.readFile(file, "utf8") };
		} catch {
			return { file, text: undefined };
		}
	}

	/** Copy the current file into the backup folder. */
	async function backup(descriptor, file) {
		if (backupRoot === "") return undefined;
		if (file === undefined) return undefined;
		const dir = path.join(backupRoot, descriptor.id);
		try {
			await fs.mkdir(dir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
			const destination = path.join(dir, `${stamp}__${path.basename(file)}`);
			await fs.copyFile(file, destination);
			const kept = (await fs.readdir(dir)).filter((name) => name.endsWith(`__${path.basename(file)}`)).sort();
			for (const stale of kept.slice(0, Math.max(0, kept.length - KEEP_BACKUPS))) {
				await fs.rm(path.join(dir, stale), { force: true });
			}
			return destination;
		} catch (error) {
			logger?.warn?.(`complugin: 补丁备份失败 ${descriptor.id}: ${renderThrown(error)}`);
			return undefined;
		}
	}

	/** Newest backup file for a descriptor, if any. */
	async function newestBackup(descriptor, file) {
		if (backupRoot === "" || file === undefined) return undefined;
		const dir = path.join(backupRoot, descriptor.id);
		try {
			const names = (await fs.readdir(dir)).filter((name) => name.endsWith(`__${path.basename(file)}`)).sort();
			return names.length === 0 ? undefined : path.join(dir, names[names.length - 1]);
		} catch {
			return undefined;
		}
	}

	return {
		/**
		 * Inspect one descriptor.
		 * @returns {Promise<{id: string, label: string, state: "applied"|"clean"|"missing"|"conflict", file: string|undefined, detail: string}>}
		 */
		async status(descriptor) {
			const { file, text } = await read(descriptor);
			if (file === undefined) return { id: descriptor.id, label: descriptor.label, state: "missing", file: undefined, detail: `找不到 ${descriptor.package}` };
			if (text === undefined) return { id: descriptor.id, label: descriptor.label, state: "missing", file, detail: "目标文件不可读" };
			if (marked(descriptor, text) || patched(descriptor, text)) {
				return { id: descriptor.id, label: descriptor.label, state: "applied", file, detail: "补丁在位" };
			}
			if (original(descriptor, text)) return { id: descriptor.id, label: descriptor.label, state: "clean", file, detail: "原始形态，可打补丁" };
			return { id: descriptor.id, label: descriptor.label, state: "conflict", file, detail: "锚点不匹配（DSH 版本可能已变），未做任何改动" };
		},

		/**
		 * Apply one descriptor.
		 * @returns {Promise<{ok: boolean, state: string, detail: string}>}
		 */
		async apply(descriptor) {
			const { file, text } = await read(descriptor);
			if (file === undefined) return { ok: false, state: "missing", detail: `找不到 ${descriptor.package}` };
			if (text === undefined) return { ok: false, state: "missing", detail: "目标文件不可读" };
			if (marked(descriptor, text) || patched(descriptor, text)) return { ok: true, state: "applied", detail: "补丁已在位，未重复写入" };
			if (!original(descriptor, text)) return { ok: false, state: "conflict", detail: "锚点不唯一或不存在，已中止（未改文件）" };
			const saved = await backup(descriptor, file);
			try {
				await fs.writeFile(file, text.replace(descriptor.find, descriptor.replace), "utf8");
			} catch (error) {
				return { ok: false, state: "error", detail: `写入失败：${renderThrown(error)}` };
			}
			const after = await read(descriptor);
			if (after.text === undefined || !(marked(descriptor, after.text) || patched(descriptor, after.text))) {
				return { ok: false, state: "error", detail: "写入后复查失败" };
			}
			logger?.info?.(`complugin: 已打补丁 ${descriptor.id}${saved === undefined ? "" : `（备份 ${path.basename(saved)}）`}`);
			return { ok: true, state: "applied", detail: saved === undefined ? "已打补丁" : `已打补丁，备份 ${path.basename(saved)}` };
		},

		/**
		 * Revert one descriptor.
		 * @returns {Promise<{ok: boolean, state: string, detail: string}>}
		 */
		async revert(descriptor) {
			const { file, text } = await read(descriptor);
			if (file === undefined) return { ok: false, state: "missing", detail: `找不到 ${descriptor.package}` };
			if (text === undefined) return { ok: false, state: "missing", detail: "目标文件不可读" };
			if (!(marked(descriptor, text) || patched(descriptor, text))) return { ok: true, state: "clean", detail: "补丁不在了，无需回滚" };
			if (patched(descriptor, text)) {
				const saved = await backup(descriptor, file);
				try {
					await fs.writeFile(file, text.replace(descriptor.replace, descriptor.find), "utf8");
				} catch (error) {
					return { ok: false, state: "error", detail: `写入失败：${renderThrown(error)}` };
				}
				logger?.info?.(`complugin: 已回滚补丁 ${descriptor.id}${saved === undefined ? "" : `（回滚前备份 ${path.basename(saved)}）`}`);
				return { ok: true, state: "clean", detail: "已按原文回滚" };
			}
			const restore = await newestBackup(descriptor, file);
			if (restore === undefined) return { ok: false, state: "conflict", detail: "补丁形态与原文都不匹配，且没有可用备份" };
			try {
				await backup(descriptor, file);
				await fs.copyFile(restore, file);
			} catch (error) {
				return { ok: false, state: "error", detail: `还原备份失败：${renderThrown(error)}` };
			}
			logger?.info?.(`complugin: 已用备份还原 ${descriptor.id}`);
			return { ok: true, state: "clean", detail: `已用备份还原（${path.basename(restore)}）` };
		},

		/** Resolve a descriptor's target file without touching it. */
		async locate(descriptor) {
			return targetOf(descriptor);
		}
	};
}

/**
 * Shape every patch module must provide.
 *
 * `absolute` is an optional escape hatch: an explicit target file instead of a
 * package lookup. It exists for unusual installs and for tests that must not
 * touch a real DSH tree.
 *
 * @param {object} spec - `{ id, label, package, file, marker, find, replace, note, absolute }`.
 * @returns {object} frozen descriptor.
 */
export function definePatch(spec) {
	for (const key of ["id", "package", "file", "find", "replace"]) {
		if (typeof spec?.[key] !== "string" || spec[key] === "") throw new TypeError(`补丁 ${spec?.id ?? "?"} 缺少 ${key}`);
	}
	return Object.freeze({
		id: String(spec.id),
		label: String(spec.label ?? spec.id),
		package: spec.package,
		file: spec.file,
		marker: String(spec.marker ?? spec.replace),
		find: spec.find,
		replace: spec.replace,
		note: String(spec.note ?? ""),
		absolute: typeof spec.absolute === "string" ? spec.absolute : ""
	});
}
