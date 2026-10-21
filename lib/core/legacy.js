/**
 * dsh-complugin — legacy namespace import.
 *
 * Four separate plugins each owned a settings namespace before this merge
 * (`auto-compact`, `auto-continue`, `vision-bridge`, …). Those blocks stay in
 * `settings.yaml` after the old packages are uninstalled, and a user who tuned
 * them should not have to retype the values into the new panel.
 *
 * So on first boot the host reads the file once, picks the top-level blocks it
 * recognises, and uses them as a **fill-only** layer: a value is imported only
 * when the merged namespace has nothing for that field yet. Anything the user
 * then edits in the new panel wins forever, and the legacy block is left
 * untouched on disk (harmless, and a manual rollback path).
 *
 * The parser is deliberately tiny: `settings.yaml` is written by DSH itself in a
 * flat `block:\n  key: value` shape, and pulling a YAML library in for that
 * would be a dependency for a one-time read.
 *
 * @module dsh-complugin/core/legacy
 */
import fs from "node:fs/promises";

/** Strip a trailing comment that is not inside quotes. */
function stripComment(text) {
	let quote = "";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quote !== "") {
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "#" && (index === 0 || /\s/u.test(text[index - 1]))) return text.slice(0, index);
	}
	return text;
}

/** Unquote and unescape one scalar. */
function scalar(raw) {
	const text = stripComment(raw).trim();
	if (text === "") return "";
	if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) || (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
		const inner = text.slice(1, -1);
		return text.startsWith('"') ? inner.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\") : inner.replace(/''/gu, "'");
	}
	if (text === "true") return true;
	if (text === "false") return false;
	if (text === "null" || text === "~") return null;
	if (/^-?\d+(?:\.\d+)?$/u.test(text)) return Number(text);
	return text;
}

/**
 * Parse the flat block shape DSH writes into a nested object.
 * @param {string} text - file contents.
 * @returns {Record<string, Record<string, unknown>>} top-level block → key/value.
 */
export function parseSettingsBlocks(text) {
	const blocks = {};
	let current;
	for (const line of String(text ?? "").split(/\r?\n/u)) {
		if (/^\s*#/u.test(line) || line.trim() === "") continue;
		const topLevel = /^([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(line);
		if (topLevel !== null) {
			const [, name, rest] = topLevel;
			const inline = stripComment(rest).trim();
			current = undefined;
			if (inline === "" || inline === "{}") {
				blocks[name] = {};
				current = blocks[name];
			}
			continue;
		}
		const nested = /^\s{1,4}([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(line);
		if (nested === null || current === undefined) continue;
		const [, key, rest] = nested;
		current[key] = scalar(rest);
	}
	return blocks;
}

/**
 * Read the legacy blocks this plugin knows how to inherit.
 *
 * @param {string} file - absolute path of `settings.yaml`.
 * @param {readonly string[]} namespaces - legacy namespace names.
 * @param {object} [logger] - optional logger.
 * @returns {Promise<Record<string, Record<string, unknown>>>} one entry per namespace that exists.
 */
export async function readLegacySettings(file, namespaces, logger) {
	const wanted = Array.isArray(namespaces) ? namespaces : [];
	if (wanted.length === 0) return {};
	let text;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") logger?.warn?.(`complugin: 旧配置读取失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
	const blocks = parseSettingsBlocks(text);
	const found = {};
	for (const namespace of wanted) {
		const block = blocks[namespace];
		if (block === undefined || Object.keys(block).length === 0) continue;
		found[namespace] = block;
	}
	return found;
}
