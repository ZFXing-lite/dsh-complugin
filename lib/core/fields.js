/**
 * dsh-complugin — the field language shared by the host and the panel.
 *
 * A module never ships UI. It declares plain field specs; the host turns them
 * into a settings schema and the browser card renders them generically. Adding
 * a feature therefore costs one host file and zero client code, which is the
 * whole point of a "补全插件" that is expected to grow.
 *
 * Side-effect free and import-free so tests, the host and (through the served
 * `/api/complugin/status` payload) the browser all agree on one definition.
 *
 * @module dsh-complugin/core/fields
 */

/** Control kinds the panel knows how to draw. */
export const FIELD_TYPES = Object.freeze(["switch", "number", "text", "secret", "textarea", "select", "multi"]);

/** Which accordion section of a drawer a field lands in. */
export const FIELD_GROUPS = Object.freeze(["basic", "tuning", "advanced"]);

/** Human labels for the three groups, used by both the panel and the docs. */
export const GROUP_LABELS = Object.freeze({
	basic: "基础",
	tuning: "调参",
	advanced: "高级"
});

/**
 * Validate and freeze one field spec.
 *
 * @param {object} spec - `{ key, label, type, default, ... }`.
 * @returns {object} the frozen spec.
 * @throws {TypeError} on a malformed spec — a bad spec must fail at import
 *   time, not when a user opens the panel.
 */
export function defineField(spec) {
	const key = String(spec?.key ?? "").trim();
	if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) throw new TypeError(`字段 key 非法：${JSON.stringify(spec?.key)}`);
	const type = String(spec?.type ?? "");
	if (!FIELD_TYPES.includes(type)) throw new TypeError(`字段 ${key} 的 type 非法：${JSON.stringify(spec?.type)}`);
	const label = String(spec?.label ?? "").trim();
	if (label === "") throw new TypeError(`字段 ${key} 缺少 label`);
	const group = spec?.group === undefined ? "basic" : String(spec.group);
	if (!FIELD_GROUPS.includes(group)) throw new TypeError(`字段 ${key} 的 group 非法：${group}`);

	const field = {
		key,
		label,
		type,
		group,
		hint: String(spec?.hint ?? ""),
		unit: String(spec?.unit ?? ""),
		placeholder: String(spec?.placeholder ?? "")
	};
	if (type === "switch") {
		field.default = spec?.default === true;
	}
	if (type === "number") {
		const min = spec?.min === undefined ? 0 : Number(spec.min);
		const max = spec?.max === undefined ? Number.MAX_SAFE_INTEGER : Number(spec.max);
		if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) throw new TypeError(`字段 ${key} 的 min/max 非法`);
		field.min = min;
		field.max = max;
		field.step = spec?.step === undefined ? 1 : Number(spec.step);
		if (!Number.isFinite(field.step) || field.step <= 0) throw new TypeError(`字段 ${key} 的 step 非法`);
		const fallback = spec?.default === undefined ? min : Number(spec.default);
		field.default = clampNumber(fallback, min, max, field.step);
	}
	if (type === "text" || type === "secret" || type === "textarea") {
		field.default = String(spec?.default ?? "");
		field.rows = spec?.rows === undefined ? 3 : Math.max(1, Math.trunc(Number(spec.rows)));
		if (spec?.maxLength !== undefined) field.maxLength = Math.max(1, Math.trunc(Number(spec.maxLength)));
	}
	if (type === "select" || type === "multi") {
		const options = Array.isArray(spec?.options) ? spec.options : [];
		if (options.length === 0) throw new TypeError(`字段 ${key} 缺少 options`);
		field.options = Object.freeze(options.map((option) => {
			const value = String(option?.value ?? "");
			if (value === "") throw new TypeError(`字段 ${key} 的选项 value 不能为空`);
			return Object.freeze({ value, label: String(option?.label ?? value), hint: String(option?.hint ?? "") });
		}));
		const allowed = field.options.map((option) => option.value);
		if (type === "select") {
			const fallback = spec?.default === undefined ? allowed[0] : String(spec.default);
			field.default = allowed.includes(fallback) ? fallback : allowed[0];
		} else {
			const fallback = Array.isArray(spec?.default) ? spec.default.map(String).filter((value) => allowed.includes(value)) : [];
			field.default = Object.freeze([...new Set(fallback)]);
		}
	}
	return Object.freeze(field);
}

/** Clamp to range and snap to the step grid. */
export function clampNumber(value, min, max, step = 1) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return min;
	const snapped = step >= 1 ? Math.round(numeric / step) * step : Math.round(numeric * 1e6) / 1e6;
	return Math.min(max, Math.max(min, snapped));
}

/**
 * Coerce one raw value into the field's own type.
 *
 * Never throws: a bad value from a hand-edited `settings.yaml` degrades to the
 * field default with a note, because a typo must not take the panel down.
 *
 * @param {object} field - a spec from {@link defineField}.
 * @param {unknown} raw - whatever the settings layer produced.
 * @returns {{value: unknown, problem: string|null}} coerced value and note.
 */
export function coerceValue(field, raw) {
	const fallback = () => ({ value: cloneDefault(field), problem: null });
	if (raw === undefined || raw === null) return fallback();
	if (field.type === "switch") {
		if (typeof raw === "boolean") return { value: raw, problem: null };
		if (raw === "true" || raw === 1 || raw === "1") return { value: true, problem: null };
		if (raw === "false" || raw === 0 || raw === "0") return { value: false, problem: null };
		return { value: field.default, problem: "期望 true/false" };
	}
	if (field.type === "number") {
		const numeric = Number(raw);
		if (!Number.isFinite(numeric)) return { value: field.default, problem: "期望数字" };
		const clamped = clampNumber(numeric, field.min, field.max, field.step);
		return { value: clamped, problem: clamped === numeric ? null : `已夹取到 ${clamped}` };
	}
	if (field.type === "text" || field.type === "secret" || field.type === "textarea") {
		const text = typeof raw === "string" ? raw : String(raw);
		const limited = field.maxLength === undefined ? text : text.slice(0, field.maxLength);
		return { value: limited, problem: null };
	}
	const allowed = field.options.map((option) => option.value);
	if (field.type === "select") {
		const text = String(raw);
		return allowed.includes(text) ? { value: text, problem: null } : { value: field.default, problem: `未知取值 ${text}` };
	}
	const list = Array.isArray(raw) ? raw : [raw];
	const picked = [...new Set(list.map(String).filter((value) => allowed.includes(value)))];
	return { value: picked, problem: picked.length === list.length ? null : "已丢弃非法选项" };
}

/** Deep-enough copy of a field default (arrays for `multi`, primitives otherwise). */
function cloneDefault(field) {
	return Array.isArray(field.default) ? [...field.default] : field.default;
}

/**
 * Fill a module's raw settings section with defaults and coerce every field.
 *
 * @param {readonly object[]} fields - the module's field specs.
 * @param {unknown} raw - the user/base section for this module.
 * @returns {{value: Record<string, unknown>, problems: Array<{key: string, note: string}>}}
 */
export function normalizeFields(fields, raw) {
	const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const value = {};
	const problems = [];
	for (const field of fields) {
		const coerced = coerceValue(field, source[field.key]);
		value[field.key] = coerced.value;
		if (coerced.problem !== null) problems.push({ key: field.key, note: coerced.problem });
	}
	return { value, problems };
}

/**
 * The panel's field payload: specs with defaults applied, grouped, and with
 * secrets reduced to a presence flag.
 *
 * @param {readonly object[]} fields - the module's field specs.
 * @param {Record<string, unknown>} values - normalized values.
 * @param {(key: string) => boolean} [secretPresent] - whether a key is stored.
 * @returns {object[]} serializable descriptors.
 */
export function describeFields(fields, values, secretPresent) {
	return fields.map((field) => {
		const value = values[field.key];
		const descriptor = {
			key: field.key,
			label: field.label,
			type: field.type,
			group: field.group,
			default: field.default,
			hint: field.hint,
			unit: field.unit,
			placeholder: field.placeholder,
			value: field.type === "secret" ? "" : value
		};
		if (field.type === "number") {
			descriptor.min = field.min;
			descriptor.max = field.max;
			descriptor.step = field.step;
		}
		if (field.type === "select" || field.type === "multi") descriptor.options = field.options;
		if (field.type === "textarea") descriptor.rows = field.rows;
		if (field.type === "secret") descriptor.present = typeof secretPresent === "function" ? secretPresent(field.key) === true : String(value ?? "") !== "";
		return descriptor;
	});
}
