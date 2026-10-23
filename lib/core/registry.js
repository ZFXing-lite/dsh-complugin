/**
 * dsh-complugin — the module registry.
 *
 * Every feature in this plugin is one module object. The registry is the whole
 * extension surface: a future patch either drops a file into `lib/modules/` and
 * adds a line to `lib/modules/index.js`, or calls {@link defineModule} from its
 * own package and mounts it through `env.mountModule(...)`.
 *
 * Two kinds are supported:
 *
 * - `hook`    — attaches to cordis events/services (auto-compact, auto-continue,
 *               vision bridge). Pure runtime behaviour, nothing is patched.
 * - `patch`   — owns a declarative edit of DSH's own source files, applied and
 *               reverted from the panel through {@link module:core/hostpatch}.
 *
 * @module dsh-complugin/core/registry
 */
import { defineField, describeFields, normalizeFields } from "./fields.js";

/** Kinds of module this plugin knows how to mount. */
export const MODULE_KINDS = Object.freeze(["hook", "patch"]);

/**
 * Validate, freeze and default one module declaration.
 *
 * @param {object} spec - the module declaration.
 * @returns {object} the frozen, fully-formed module.
 * @throws {TypeError} on a malformed declaration.
 */
export function defineModule(spec) {
	const id = String(spec?.id ?? "");
	if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(id)) throw new TypeError(`模块 id 非法：${JSON.stringify(spec?.id)}`);
	const kind = String(spec?.kind ?? "hook");
	if (!MODULE_KINDS.includes(kind)) throw new TypeError(`模块 ${id} 的 kind 非法：${kind}`);
	const title = String(spec?.title ?? "").trim();
	if (title === "") throw new TypeError(`模块 ${id} 缺少 title`);
	const fields = (Array.isArray(spec?.fields) ? spec.fields : []).map(defineField);
	const keys = new Set();
	for (const field of fields) {
		if (keys.has(field.key)) throw new TypeError(`模块 ${id} 的字段 ${field.key} 重复`);
		keys.add(field.key);
	}
	if (typeof spec?.mount !== "function") throw new TypeError(`模块 ${id} 缺少 mount()`);

	const actions = (Array.isArray(spec?.actions) ? spec.actions : []).map((action) => {
		const actionId = String(action?.id ?? "");
		if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(actionId)) throw new TypeError(`模块 ${id} 的 action id 非法：${JSON.stringify(action?.id)}`);
		const tone = String(action?.tone ?? "ghost");
		if (!["primary", "danger", "ghost"].includes(tone)) throw new TypeError(`模块 ${id} 的 action ${actionId} 的 tone 非法：${tone}`);
		return Object.freeze({
			id: actionId,
			label: String(action?.label ?? actionId),
			desc: String(action?.desc ?? ""),
			tone,
			confirm: String(action?.confirm ?? ""),
			route: String(action?.route ?? ""),
			// Field a result list (data.models) writes into when the user clicks one.
			resultField: String(action?.resultField ?? ""),
			needs: Object.freeze(Array.isArray(action?.needs) ? action.needs.map(String) : [])
		});
	});

	return Object.freeze({
		id,
		kind,
		title,
		summary: String(spec?.summary ?? ""),
		legacy: String(spec?.legacy ?? ""),
		order: Number.isFinite(spec?.order) ? Number(spec.order) : 100,
		icon: String(spec?.icon ?? ""),
		inject: Object.freeze(Array.isArray(spec?.inject) ? spec.inject.map(String) : []),
		fields: Object.freeze(fields),
		actions: Object.freeze(actions),
		patch: spec?.patch === undefined || spec?.patch === null ? null : spec.patch,
		mount: spec.mount,
		docs: String(spec?.docs ?? "")
	});
}

/**
 * Validate a whole module list and put it in panel order.
 * @param {readonly object[]} specs - raw declarations.
 * @returns {object[]} frozen modules, sorted by `order` then `id`.
 */
export function defineModules(specs) {
	const modules = (Array.isArray(specs) ? specs : []).map(defineModule);
	const seen = new Set();
	for (const module of modules) {
		if (seen.has(module.id)) throw new TypeError(`模块 id 重复：${module.id}`);
		seen.add(module.id);
	}
	return modules.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/**
 * Default values for one module's settings section.
 * @param {object} module - a module from {@link defineModule}.
 * @returns {Record<string, unknown>} field defaults.
 */
export function moduleDefaults(module) {
	return normalizeFields(module.fields, {}).value;
}

/**
 * The full settings default object, keyed by module id.
 * @param {readonly object[]} modules - mounted modules.
 * @returns {Record<string, Record<string, unknown>>} defaults for every module.
 */
export function defaultsFor(modules) {
	const value = {};
	for (const module of modules) value[module.id] = moduleDefaults(module);
	return value;
}

/**
 * Normalize a whole `complugin` settings value against the module list.
 *
 * Unknown module ids in the stored section are kept out of the result but
 * reported, so a module removed in a later version cannot resurrect itself and
 * cannot break the panel.
 *
 * @param {readonly object[]} modules - mounted modules.
 * @param {unknown} raw - the resolved settings value.
 * @returns {{enabled: boolean, modules: Record<string, Record<string, unknown>>, problems: Array<{module: string, key: string, note: string}>}}
 */
export function normalizeConfig(modules, raw) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	const section = source.modules !== null && typeof source.modules === "object" ? source.modules : {};
	const value = {};
	const problems = [];
	for (const module of modules) {
		const normalized = normalizeFields(module.fields, section[module.id]);
		value[module.id] = normalized.value;
		for (const problem of normalized.problems) problems.push({ module: module.id, key: problem.key, note: problem.note });
	}
	return { enabled: source.enabled !== false, modules: value, problems };
}

/**
 * Serialize one module for the panel: declaration, current values, live status.
 *
 * @param {object} module - the module.
 * @param {object} context - `{ values, status, enabled, secretPresent }`.
 * @returns {object} JSON-safe descriptor.
 */
export function describeModule(module, context) {
	const values = context?.values ?? {};
	const status = context?.status ?? {};
	return {
		id: module.id,
		title: module.title,
		summary: module.summary,
		legacy: module.legacy,
		kind: module.kind,
		order: module.order,
		docs: module.docs,
		patch: module.patch === null ? null : {
			id: module.patch.id,
			label: module.patch.label,
			note: module.patch.note,
			package: module.patch.package,
			file: module.patch.file
		},
		enabled: context?.enabled !== false,
		fields: describeFields(module.fields, values, context?.secretPresent),
		actions: module.actions.map((action) => ({
			id: action.id,
			label: action.label,
			desc: action.desc,
			tone: action.tone,
			confirm: action.confirm,
			route: action.route,
			resultField: action.resultField,
			needs: action.needs
		})),
		status: {
			ready: status.ready !== false,
			sign: String(status.sign ?? "idle"),
			badge: String(status.badge ?? ""),
			line: String(status.line ?? ""),
			entries: Array.isArray(status.entries) ? status.entries : [],
			stats: Array.isArray(status.stats) ? status.stats : [],
			error: String(status.error ?? ""),
			patch: status.patch ?? null
		}
	};
}
