/**
 * dsh-complugin — durable JSON stores.
 *
 * Every module that needs to remember something across restarts gets its own
 * file under `$DSH_HOME/complugin/`. Writes are debounced and atomic-ish (write
 * then rename) so a crash mid-write cannot leave a half-file behind, and a
 * corrupt file is discarded instead of taking a module down.
 *
 * @module dsh-complugin/core/store
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Debounce window shared by every store instance. */
const FLUSH_DELAY_MS = 400;

/**
 * Create a JSON-backed key/value store.
 *
 * @param {object} options - `{ file, ttlMs, maxEntries, logger }`.
 * @returns {{load: () => Promise<void>, get: (key: string) => unknown, set: (key: string, value: unknown) => void, delete: (key: string) => void, clear: () => void, size: () => number, flush: () => Promise<void>, dispose: () => Promise<void>}}
 */
export function createJsonStore(options) {
	const file = String(options?.file ?? "");
	const ttlMs = Number.isFinite(options?.ttlMs) ? Number(options.ttlMs) : 0;
	const maxEntries = Number.isFinite(options?.maxEntries) ? Math.max(1, Math.trunc(Number(options.maxEntries))) : 400;
	const logger = options?.logger;
	const entries = new Map();
	let timer;
	let loaded = false;

	const prune = () => {
		const now = Date.now();
		if (ttlMs > 0) {
			for (const [key, entry] of entries) {
				const at = Number(entry?.at ?? 0);
				if (at > 0 && now - at > ttlMs) entries.delete(key);
			}
		}
		if (entries.size > maxEntries) {
			const ordered = [...entries.entries()].sort((left, right) => Number(left[1]?.at ?? 0) - Number(right[1]?.at ?? 0));
			for (const [key] of ordered.slice(0, entries.size - maxEntries)) entries.delete(key);
		}
	};

	const flush = async () => {
		if (file === "") return;
		prune();
		const payload = { version: 1, savedAt: new Date().toISOString(), entries: Object.fromEntries(entries) };
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			const temporary = `${file}.${process.pid}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
			await fs.rename(temporary, file);
		} catch (error) {
			logger?.warn?.(`complugin: 缓存写入失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const schedule = () => {
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, FLUSH_DELAY_MS);
		timer.unref?.();
	};

	return {
		async load() {
			if (loaded || file === "") {
				loaded = true;
				return;
			}
			loaded = true;
			try {
				const raw = await fs.readFile(file, "utf8");
				const parsed = JSON.parse(raw);
				const source = parsed !== null && typeof parsed === "object" && parsed.entries !== null && typeof parsed.entries === "object" ? parsed.entries : {};
				for (const [key, entry] of Object.entries(source)) {
					if (entry !== null && typeof entry === "object") entries.set(key, entry);
				}
				prune();
			} catch (error) {
				if (error?.code !== "ENOENT") logger?.warn?.(`complugin: 缓存读取失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		get(key) {
			const entry = entries.get(String(key));
			if (entry === undefined) return undefined;
			if (ttlMs > 0 && Number(entry?.at ?? 0) > 0 && Date.now() - Number(entry.at) > ttlMs) {
				entries.delete(String(key));
				return undefined;
			}
			return entry.value;
		},
		set(key, value) {
			entries.set(String(key), { value, at: Date.now() });
			schedule();
		},
		delete(key) {
			if (entries.delete(String(key))) schedule();
		},
		clear() {
			entries.clear();
			schedule();
		},
		size() {
			return entries.size;
		},
		flush,
		async dispose() {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			await flush();
		}
	};
}
