/**
 * dsh-complugin — browser half.
 *
 * ONE surface: 设置 → 插件 → 插件配置 gets a card titled 「DSH功能补全插件」,
 * registered into the `settings.plugin.item` slot under the `complugin`
 * namespace.
 *
 * The card is a *generic renderer*: it knows nothing about 自动压缩 or 视觉桥,
 * it renders whatever `GET /api/complugin/status` describes — module order,
 * titles, status lines, stats, field groups and action buttons all come from
 * the host. Adding a feature later therefore costs zero lines here.
 *
 * Self-contained: consumes only `react`, the injected `slots` service, and the
 * `/api/complugin/*` routes.
 */
window.__ModuleLoader__.load({
	id: "dsh-complugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const NAMESPACE = "complugin";
		const STATUS_URL = "/api/complugin/status";
		const MASTER_URL = "/api/complugin/master";
		const CONFIG_URL = "/api/complugin/config";
		const ACTION_URL = "/api/complugin/action";
		const PATCH_URL = "/api/complugin/patch";
		const POLL_MS = 3000;

		const css = `
.cp_root{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;min-width:0;overflow:hidden;display:flex;flex-direction:column}
.cp_head{display:flex;align-items:flex-start;gap:12px;justify-content:space-between;padding:14px 16px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),transparent);border-bottom:1px solid var(--dsw-alias-border-l2)}
.cp_headmain{min-width:0;display:flex;flex-direction:column;gap:3px}
.cp_title{font-size:15px;font-weight:650;line-height:22px;letter-spacing:.2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cp_sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cp_headtrail{display:flex;align-items:center;gap:8px;flex:none;padding-top:2px}
.cp_chips{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}
.cp_chip{display:inline-flex;align-items:center;gap:6px;min-height:22px;padding:1px 8px;border-radius:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2)}
.cp_chip b{font-weight:600;color:var(--dsw-alias-label-primary)}
.cp_chip[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.cp_chip[data-tone=warn]{color:var(--dsw-alias-state-warning-primary,#c98a00);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a00) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a00) 9%,transparent)}
.cp_chip[data-tone=err]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.cp_list{display:flex;flex-direction:column;gap:8px;padding:10px 12px}
.cp_mod{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;transition:border-color .14s var(--ds-ease-in-out),box-shadow .14s var(--ds-ease-in-out)}
.cp_mod[data-open=true]{border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv1)}
.cp_modhead{box-sizing:border-box;width:100%;min-height:50px;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;display:flex;align-items:center;gap:10px;padding:11px 13px}
.cp_mod[data-open=true]>.cp_modhead,.cp_modhead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cp_rail{flex:none;width:3px;height:26px;border-radius:999px;background:var(--dsw-alias-border-l1)}
.cp_rail[data-sign=on]{background:var(--dsw-alias-state-success-primary)}
.cp_rail[data-sign=warn]{background:var(--dsw-alias-state-warning-primary,#c98a00)}
.cp_rail[data-sign=error]{background:var(--dsw-alias-state-error-primary)}
.cp_rail[data-sign=off]{background:var(--dsw-alias-border-l2)}
.cp_modtitle{min-width:0;display:flex;flex-direction:column;gap:2px;flex:1}
.cp_modname{font-size:13.5px;font-weight:600;line-height:19px;display:flex;align-items:center;gap:7px;min-width:0}
.cp_modname span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp_modsum{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp_trail{display:inline-flex;align-items:center;gap:7px;flex:none;color:var(--dsw-alias-label-tertiary)}
.cp_badge{min-height:20px;padding:1px 7px;border-radius:5px;font-size:11px;line-height:16px;display:inline-flex;align-items:center;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border:1px solid transparent}
.cp_badge[data-sign=on]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.cp_badge[data-sign=warn]{color:var(--dsw-alias-state-warning-primary,#c98a00);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a00) 10%,transparent)}
.cp_badge[data-sign=error]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.cp_badge[data-kind=patch]{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);background:transparent}
.cp_chev{flex:none;transition:transform .14s var(--ds-ease-in-out)}
.cp_mod[data-open=true] .cp_chev{transform:rotate(180deg)}
.cp_body{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);padding:11px 13px 13px;display:flex;flex-direction:column;gap:11px}
.cp_statusline{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.cp_statusline[data-sign=error]{color:var(--dsw-alias-state-error-primary)}
.cp_dot{flex:none;width:7px;height:7px;border-radius:999px;margin-top:6px;background:var(--dsw-alias-label-tertiary)}
.cp_dot[data-sign=on]{background:var(--dsw-alias-state-success-primary)}
.cp_dot[data-sign=warn]{background:var(--dsw-alias-state-warning-primary,#c98a00)}
.cp_dot[data-sign=error]{background:var(--dsw-alias-state-error-primary)}
.cp_stats{display:flex;flex-wrap:wrap;gap:6px}
.cp_stat{display:inline-flex;align-items:baseline;gap:6px;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.cp_stat b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.cp_group{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.cp_group[data-open=true]{border-color:var(--dsw-alias-border-l1)}
.cp_grouphead{box-sizing:border-box;width:100%;min-height:32px;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.cp_grouphead:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cp_groupbody{padding:2px 10px 10px;display:flex;flex-direction:column;gap:9px;border-top:1px dashed var(--dsw-alias-border-l2)}
.cp_row{display:grid;grid-template-columns:minmax(150px,208px) minmax(0,1fr);gap:4px 12px;align-items:start;padding-top:8px}
.cp_label{font-size:12px;font-weight:600;line-height:17px;padding-top:5px;display:flex;align-items:baseline;gap:6px}
.cp_key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.cp_hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:3px 0 0}
.cp_ctl{min-width:0;display:flex;flex-direction:column;gap:4px}
.cp_input{box-sizing:border-box;width:100%;min-height:30px;font:inherit;font-size:13px;padding:4px 8px;border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);outline:none}
.cp_input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.cp_input:disabled{opacity:.55}
textarea.cp_input{min-height:64px;resize:vertical;line-height:18px}
.cp_inline{display:flex;align-items:center;gap:8px;min-height:30px;flex-wrap:wrap}
.cp_switch{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:12px}
.cp_switch input{position:absolute;opacity:0;width:0;height:0}
.cp_track{width:34px;height:19px;border-radius:999px;background:var(--dsw-alias-border-l1);position:relative;transition:background .14s var(--ds-ease-in-out);flex:none}
.cp_track::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);transition:transform .14s var(--ds-ease-in-out)}
.cp_switch input:checked+.cp_track{background:var(--dsw-alias-state-business-primary)}
.cp_switch input:checked+.cp_track::after{transform:translateX(15px)}
.cp_switch input:disabled+.cp_track{opacity:.5}
.cp_pills{display:flex;flex-wrap:wrap;gap:5px}
.cp_pill{display:inline-flex;align-items:center;gap:5px;min-height:24px;padding:1px 9px;border-radius:999px;font-size:11.5px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.cp_pill[data-on=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.cp_pill input{display:none}
.cp_meta{display:flex;align-items:center;gap:8px;min-height:16px;flex-wrap:wrap}
.cp_dirty{font-size:11px;color:var(--dsw-alias-state-business-primary)}
.cp_reset{font:inherit;font-size:11px;cursor:pointer;background:0 0;border:0;padding:0;color:var(--dsw-alias-label-tertiary);text-decoration:underline}
.cp_reset:hover{color:var(--dsw-alias-label-primary)}
.cp_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}
.cp_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:4px 11px;min-height:26px;display:inline-flex;align-items:center;gap:6px}
.cp_btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover)}
.cp_btn:disabled{opacity:.45;cursor:default}
.cp_btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-interactive-text);font-weight:600}
.cp_btn[data-primary=true]:hover:not(:disabled){filter:brightness(1.08)}
.cp_btn[data-tone=danger]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
.cp_spacer{flex:1}
.cp_note{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin:0}
.cp_note[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.cp_note[data-tone=err]{color:var(--dsw-alias-state-error-primary)}
.cp_patch{border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;padding:9px 11px;display:flex;flex-direction:column;gap:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 60%,transparent)}
.cp_patchhead{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;flex-wrap:wrap}
.cp_patchfile{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-weight:400;word-break:break-all}
.cp_logs{display:flex;flex-direction:column;gap:3px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px}
.cp_log{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
.cp_log[data-level=warn]{color:var(--dsw-alias-state-warning-primary,#c98a00)}
.cp_log[data-level=error]{color:var(--dsw-alias-state-error-primary)}
.cp_foot{display:flex;align-items:center;gap:8px;padding:9px 16px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.cp_empty{padding:14px 16px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
`;
		const STYLE_ID = "dsh-complugin/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-complugin";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const GROUP_ORDER = ["basic", "tuning", "advanced"];
		const GROUP_LABELS = { basic: "基础", tuning: "调参", advanced: "高级" };
		const GROUP_HINTS = {
			basic: "日常开关，改完点保存即生效",
			tuning: "行为细节，一般用默认值即可",
			advanced: "谨慎修改，出问题先恢复默认"
		};

		/** A tiny external store: one snapshot object, many subscribers. */
		function createStore(initial) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
				set: (next) => {
					snapshot = next;
					for (const listener of [...listeners]) {
						try {
							listener();
						} catch (error) {
							console.error("[complugin] panel listener threw:", error);
						}
					}
				}
			};
		}

		/** POST JSON and return the parsed payload, or `{ ok:false }` on any failure. */
		async function post(url, body) {
			try {
				const response = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify(body ?? {})
				});
				if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
				return await response.json();
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error) };
			}
		}

		/** GET JSON; same contract as `post`. */
		async function get(url) {
			try {
				const response = await fetch(url, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
				if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
				return await response.json();
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error) };
			}
		}

		/** True when the field carries a non-empty, non-default value in the draft set. */
		function sameValue(a, b) {
			if (Array.isArray(a) && Array.isArray(b)) {
				if (a.length !== b.length) return false;
				return a.every((item, index) => item === b[index]);
			}
			return a === b;
		}

		var CompluginController = class {
			constructor() {
				this.drafts = new Map();
				this.busy = new Map();
				this.notices = new Map();
				this.timer = undefined;
				this.disposed = false;
				this.store = createStore({
					loading: true,
					error: "",
					data: undefined,
					drafts: {},
					busy: {},
					notices: {},
					updatedAt: 0
				});
			}

			/** Publish the derived snapshot the panel renders. */
			publish() {
				const drafts = {};
				for (const [moduleId, fields] of this.drafts) drafts[moduleId] = { ...fields };
				const busy = {};
				for (const [key, value] of this.busy) busy[key] = value;
				const notices = {};
				for (const [key, value] of this.notices) notices[key] = value;
				const previous = this.store.getSnapshot();
				this.store.set({
					loading: previous.loading,
					error: previous.error,
					data: previous.data,
					updatedAt: previous.updatedAt,
					drafts,
					busy,
					notices
				});
			}

			setNotice(key, text, tone) {
				this.notices.set(key, { text, tone, at: Date.now() });
				this.publish();
				const stamp = this.notices.get(key)?.at;
				setTimeout(() => {
					if (this.disposed) return;
					if (this.notices.get(key)?.at !== stamp) return;
					this.notices.delete(key);
					this.publish();
				}, 4200);
			}

			async refresh() {
				const payload = await get(STATUS_URL);
				if (this.disposed) return;
				const previous = this.store.getSnapshot();
				if (payload.ok === false) {
					this.store.set({ ...previous, loading: false, error: String(payload.error ?? "读取失败") });
					return;
				}
				this.store.set({ ...previous, loading: false, error: "", data: payload, updatedAt: Date.now() });
			}

			start() {
				void this.refresh();
				this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
			}

			dispose() {
				this.disposed = true;
				if (this.timer !== undefined) clearInterval(this.timer);
				this.timer = undefined;
			}

			moduleById(id) {
				return (this.store.getSnapshot().data?.modules ?? []).find((module) => module.id === id);
			}

			/** Effective value for one field: the draft when staged, else the stored value. */
			valueOf(module, field) {
				const draft = this.drafts.get(module.id);
				if (draft !== undefined && Object.hasOwn(draft, field.key)) return draft[field.key];
				return field.value;
			}

			isDirty(module) {
				const draft = this.drafts.get(module.id);
				if (draft === undefined) return false;
				for (const key of Object.keys(draft)) {
					const field = module.fields.find((entry) => entry.key === key);
					if (field === undefined) continue;
					if (!sameValue(draft[key], field.value)) return true;
				}
				return false;
			}

			dirtyValues(module) {
				const draft = this.drafts.get(module.id);
				if (draft === undefined) return {};
				const out = {};
				for (const key of Object.keys(draft)) {
					const field = module.fields.find((entry) => entry.key === key);
					if (field === undefined) continue;
					if (sameValue(draft[key], field.value)) continue;
					out[key] = draft[key];
				}
				return out;
			}

			setField(moduleId, key, value) {
				const draft = this.drafts.get(moduleId) ?? {};
				draft[key] = value;
				this.drafts.set(moduleId, draft);
				this.publish();
			}

			resetField(moduleId, field) {
				this.setField(moduleId, field.key, field.default);
			}

			discard(moduleId) {
				this.drafts.delete(moduleId);
				this.publish();
			}

			async save(moduleId) {
				const module = this.moduleById(moduleId);
				if (module === undefined) return;
				const values = this.dirtyValues(module);
				if (Object.keys(values).length === 0) return;
				this.busy.set(moduleId, true);
				this.publish();
				const result = await post(CONFIG_URL, { module: moduleId, values });
				this.busy.delete(moduleId);
				if (result.ok === false) {
					this.setNotice(moduleId, result.error ?? result.detail ?? "保存失败", "err");
					return;
				}
				this.drafts.delete(moduleId);
				this.setNotice(moduleId, result.detail || "已保存", "ok");
				await this.refresh();
			}

			async setMaster(enabled) {
				this.busy.set("master", true);
				this.publish();
				const result = await post(MASTER_URL, { enabled });
				this.busy.delete("master");
				if (result.ok === false) {
					this.setNotice("master", result.error ?? "切换失败", "err");
					return;
				}
				this.setNotice("master", enabled ? "已开启全部模块" : "已暂停全部模块", "ok");
				await this.refresh();
			}

			async runAction(moduleId, action) {
				const module = this.moduleById(moduleId);
				const key = `${moduleId}:${action.id}`;
				this.busy.set(key, true);
				this.publish();
				const values = module === undefined ? {} : this.effectiveValues(module);
				const url = action.route ?? ACTION_URL;
				const body = action.route === undefined
					? { module: moduleId, action: action.id, values }
					: { action: action.id, values };
				const result = await post(url, body);
				this.busy.delete(key);
				const text = result.ok === false
					? result.error ?? result.detail ?? "执行失败"
					: result.detail || "完成";
				this.setNotice(key, text, result.ok === false ? "err" : "ok");
				await this.refresh();
			}

			/** Every current field value of a module, drafts included (action payloads). */
			effectiveValues(module) {
				const out = {};
				for (const field of module.fields) out[field.key] = this.valueOf(module, field);
				return out;
			}

			async runPatch(moduleId, action) {
				const key = `${moduleId}:patch:${action}`;
				this.busy.set(key, true);
				this.publish();
				const result = await post(PATCH_URL, { module: moduleId, action });
				this.busy.delete(key);
				this.setNotice(key, result.ok === false ? result.error ?? result.detail ?? "执行失败" : result.detail || "完成", result.ok === false ? "err" : "ok");
				await this.refresh();
			}

			inject() {
				return {
					store: this.store,
					save: (moduleId) => { void this.save(moduleId); },
					discard: (moduleId) => this.discard(moduleId),
					setField: (moduleId, key, value) => this.setField(moduleId, key, value),
					resetField: (moduleId, field) => this.resetField(moduleId, field),
					setMaster: (enabled) => { void this.setMaster(enabled); },
					runAction: (moduleId, action) => { void this.runAction(moduleId, action); },
					runPatch: (moduleId, action) => { void this.runPatch(moduleId, action); },
					refresh: () => { void this.refresh(); }
				};
			}
		};

		/** Subscribe a component to the controller store. */
		function useStore(store) {
			const [snapshot, setSnapshot] = react.useState(store.getSnapshot());
			react.useEffect(() => {
				setSnapshot(store.getSnapshot());
				return store.subscribe(() => setSnapshot(store.getSnapshot()));
			}, [store]);
			return snapshot;
		}

		function Chevron({ open }) {
			return react.createElement("svg", {
				className: "cp_chev", width: 14, height: 14, viewBox: "0 0 24 24",
				fill: "none", stroke: "currentColor", strokeWidth: 2,
				style: open ? { transform: "rotate(180deg)" } : undefined
			}, react.createElement("path", { d: "M6 9l6 6 6-6", strokeLinecap: "round", strokeLinejoin: "round" }));
		}

		function Switch({ checked, disabled, onChange, label }) {
			return react.createElement("label", { className: "cp_switch" },
				react.createElement("input", { type: "checkbox", checked: checked === true, disabled, onChange: (event) => onChange(event.target.checked) }),
				react.createElement("span", { className: "cp_track" }),
				label === undefined ? null : react.createElement("span", null, label)
			);
		}

		/** One field control, chosen from the declared type. */
		function FieldControl({ field, value, disabled, onChange }) {
			if (field.type === "switch") {
				return react.createElement("div", { className: "cp_inline" },
					react.createElement(Switch, { checked: value === true, disabled, onChange })
				);
			}
			if (field.type === "select") {
				return react.createElement("select", {
					className: "cp_input", disabled, value: String(value ?? ""),
					onChange: (event) => onChange(event.target.value)
				}, (field.options ?? []).map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label ?? option.value)));
			}
			if (field.type === "multi") {
				const selected = Array.isArray(value) ? value : [];
				return react.createElement("div", { className: "cp_pills" }, (field.options ?? []).map((option) => {
					const on = selected.includes(option.value);
					return react.createElement("label", {
						key: option.value, className: "cp_pill", "data-on": on ? "true" : undefined,
						title: option.hint ?? ""
					},
						react.createElement("input", {
							type: "checkbox", checked: on, disabled,
							onChange: () => {
								const next = on ? selected.filter((item) => item !== option.value) : [...selected, option.value];
								onChange(next);
							}
						}),
						option.label ?? option.value
					);
				}));
			}
			if (field.type === "textarea") {
				return react.createElement("textarea", {
					className: "cp_input", rows: field.rows ?? 3, disabled, spellCheck: false,
					value: String(value ?? ""),
					placeholder: field.placeholder ?? "",
					onChange: (event) => onChange(event.target.value)
				});
			}
			if (field.type === "number") {
				return react.createElement("div", { className: "cp_inline" },
					react.createElement("input", {
						className: "cp_input", type: "number", disabled, inputMode: "decimal",
						min: field.min, max: field.max, step: field.step,
						value: value === undefined || value === null ? "" : String(value),
						onChange: (event) => {
							const text = event.target.value;
							onChange(text === "" ? "" : Number(text));
						}
					}),
					field.unit === undefined ? null : react.createElement("span", { className: "cp_hint", style: { margin: 0 } }, field.unit)
				);
			}
			const isSecret = field.type === "secret";
			return react.createElement("input", {
				className: "cp_input", type: isSecret ? "password" : "text", disabled,
				spellCheck: false, autoComplete: "off",
				value: String(value ?? ""),
				placeholder: isSecret ? (field.present ? "已保存（留空则不修改）" : field.placeholder ?? "未设置") : field.placeholder ?? "",
				onChange: (event) => onChange(event.target.value)
			});
		}

		/** One collapsible group of fields (基础 / 调参 / 高级). */
		function FieldGroup({ group, fields, module, controller, state, disabled, defaultOpen }) {
			const [open, setOpen] = react.useState(defaultOpen);
			if (fields.length === 0) return null;
			const label = GROUP_LABELS[group] ?? group;
			return react.createElement("div", { className: "cp_group", "data-open": open ? "true" : undefined },
				react.createElement("button", {
					type: "button", className: "cp_grouphead", "aria-expanded": open,
					onClick: () => setOpen((value) => !value)
				},
					react.createElement("span", null, label),
					react.createElement("span", { className: "cp_hint", style: { margin: 0, textTransform: "none", letterSpacing: 0, fontWeight: 400 } }, `${fields.length}`),
					react.createElement("span", { className: "cp_spacer" }),
					react.createElement(Chevron, { open })
				),
				open ? react.createElement("div", { className: "cp_groupbody" }, fields.map((field) => {
					const value = controller.valueOf(module, field);
					const draft = state.drafts[module.id] ?? {};
					const touched = Object.hasOwn(draft, field.key) && !sameValue(draft[field.key], field.value);
					return react.createElement("div", { className: "cp_row", key: field.key },
						react.createElement("div", null,
							react.createElement("label", { className: "cp_label" },
								react.createElement("span", null, field.label),
								react.createElement("span", { className: "cp_key" }, field.key)
							),
							field.hint ? react.createElement("p", { className: "cp_hint" }, field.hint) : null
						),
						react.createElement("div", { className: "cp_ctl" },
							react.createElement(FieldControl, {
								field, value, disabled,
								onChange: (next) => controller.setField(module.id, field.key, next)
							}),
							react.createElement("div", { className: "cp_meta" },
								touched ? react.createElement("span", { className: "cp_dirty" }, "改动未保存") : null,
								touched ? react.createElement("button", {
									type: "button", className: "cp_reset", disabled,
									onClick: () => controller.resetField(module.id, field)
								}, "恢复默认") : null
							)
						)
					);
				})) : null
			);
		}

		/** The patch block: state, apply/revert, and why it exists. */
		function PatchBlock({ module, state, controller, disabled }) {
			const patch = module.status?.patch ?? null;
			if (module.patch === null) return null;
			const stateName = patch?.state ?? "unknown";
			const tone = stateName === "applied" ? "on" : stateName === "conflict" || stateName === "missing" ? "warn" : "off";
			const badge = { applied: "已应用", clean: "未应用", missing: "找不到目标", conflict: "锚点冲突", unknown: "未知" }[stateName] ?? stateName;
			const busy = state.busy[`${module.id}:patch:apply`] === true || state.busy[`${module.id}:patch:revert`] === true;
			return react.createElement("div", { className: "cp_patch" },
				react.createElement("div", { className: "cp_patchhead" },
					react.createElement("span", null, module.patch.label ?? "宿主补丁"),
					react.createElement("span", { className: "cp_badge", "data-sign": tone }, badge),
					react.createElement("span", { className: "cp_patchfile" }, `${module.patch.package}/${module.patch.file}`)
				),
				patch?.detail ? react.createElement("p", { className: "cp_note" }, patch.detail) : null,
				module.patch.note ? react.createElement("p", { className: "cp_note" }, module.patch.note) : null,
				react.createElement("div", { className: "cp_actions" },
					react.createElement("button", {
						type: "button", className: "cp_btn", "data-primary": "true",
						disabled: disabled || busy || stateName === "applied",
						onClick: () => controller.runPatch(module.id, "apply")
					}, "应用补丁"),
					react.createElement("button", {
						type: "button", className: "cp_btn", "data-tone": "danger",
						disabled: disabled || busy || stateName !== "applied",
						onClick: () => controller.runPatch(module.id, "revert")
					}, "回滚"),
					react.createElement("button", {
						type: "button", className: "cp_btn",
						disabled: busy,
						onClick: () => controller.runPatch(module.id, "status")
					}, "重新检测")
				)
			);
		}

		/** One module card. */
		function ModuleCard({ module, state, controller, defaultOpen }) {
			const [open, setOpen] = react.useState(defaultOpen);
			const draft = state.drafts[module.id] ?? {};
			const dirty = module.fields.some((field) => Object.hasOwn(draft, field.key) && !sameValue(draft[field.key], field.value));
			const saving = state.busy[module.id] === true;
			const notice = state.notices[module.id];
			const sign = module.status?.sign ?? "idle";
			const disabled = saving === true || state.data?.plugin?.enabled === false;
			const groups = GROUP_ORDER
				.map((group) => ({ group, fields: module.fields.filter((field) => (field.group ?? "basic") === group) }))
				.filter((entry) => entry.fields.length > 0);
			const logs = Array.isArray(module.status?.entries) ? module.status.entries.slice(0, 6) : [];
			const stats = Array.isArray(module.status?.stats) ? module.status.stats : [];
			return react.createElement("section", { className: "cp_mod", "data-open": open ? "true" : undefined },
				react.createElement("button", {
					type: "button", className: "cp_modhead", "aria-expanded": open,
					onClick: () => setOpen((value) => !value)
				},
					react.createElement("span", { className: "cp_rail", "data-sign": sign }),
					react.createElement("span", { className: "cp_modtitle" },
						react.createElement("span", { className: "cp_modname" },
							react.createElement("span", null, module.title),
							module.kind === "patch" ? react.createElement("span", { className: "cp_badge", "data-kind": "patch" }, "补丁") : null,
							module.patch !== null ? react.createElement("span", { className: "cp_badge", "data-kind": "patch" }, "含补丁") : null
						),
						react.createElement("span", { className: "cp_modsum" }, module.summary || module.docs || "")
					),
					react.createElement("span", { className: "cp_trail" },
						module.status?.badge ? react.createElement("span", { className: "cp_badge", "data-sign": sign }, module.status.badge) : null,
						react.createElement("span", { className: "cp_dot", "data-sign": sign }),
						react.createElement(Chevron, { open })
					)
				),
				open ? react.createElement("div", { className: "cp_body" },
					module.status?.line ? react.createElement("div", { className: "cp_statusline", "data-sign": sign },
						react.createElement("span", { className: "cp_dot", "data-sign": sign }),
						react.createElement("span", null, module.status.line)
					) : null,
					stats.length > 0 ? react.createElement("div", { className: "cp_stats" }, stats.map((stat, index) => react.createElement("span", { className: "cp_stat", key: `${module.id}-stat-${index}` },
						react.createElement("span", null, stat.label ?? stat.key ?? "·"),
						react.createElement("b", null, String(stat.value ?? ""))
					))) : null,
					groups.map((entry) => react.createElement(FieldGroup, {
						key: entry.group,
						group: entry.group,
						fields: entry.fields,
						module,
						controller,
						state,
						disabled,
						defaultOpen: entry.group !== "advanced"
					})),
					module.actions.length > 0 ? react.createElement("div", { className: "cp_actions" },
						module.actions.map((action) => react.createElement("button", {
							key: `${module.id}:${action.id}`,
							type: "button",
							className: "cp_btn",
							"data-tone": action.tone === "danger" ? "danger" : undefined,
							disabled: disabled || state.busy[`${module.id}:${action.id}`] === true || (Array.isArray(action.needs) && action.needs.some((key) => {
								const field = module.fields.find((entry) => entry.key === key);
								if (field === undefined) return true;
								const value = controller.valueOf(module, field);
								return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
							})),
							title: action.desc ?? "",
							onClick: () => controller.runAction(module.id, action)
						}, action.label ?? action.id))
					) : null,
					react.createElement(PatchBlock, { module, state, controller, disabled }),
					logs.length > 0 ? react.createElement("div", { className: "cp_logs" }, logs.map((entry, index) => react.createElement("div", {
						className: "cp_log", key: `${module.id}-log-${index}`, "data-level": entry.level ?? "info"
					}, String(entry.text ?? "")))) : null,
					module.docs ? react.createElement("p", { className: "cp_note" }, module.docs) : null,
					react.createElement("div", { className: "cp_actions" },
						notice ? react.createElement("span", { className: "cp_note", "data-tone": notice.tone === "err" ? "err" : "ok" }, notice.text) : null,
						react.createElement("span", { className: "cp_spacer" }),
						dirty ? react.createElement("span", { className: "cp_dirty" }, "有未保存的改动") : null,
						react.createElement("button", {
							type: "button", className: "cp_btn",
							disabled: !dirty || saving,
							onClick: () => controller.discard(module.id)
						}, "丢弃"),
						react.createElement("button", {
							type: "button", className: "cp_btn", "data-primary": "true",
							disabled: !dirty || saving,
							onClick: () => controller.save(module.id)
						}, saving ? "保存中…" : "保存")
					)
				) : null
			);
		}

		function CompluginPanel(props) {
			const state = useStore(props.store);
			const data = state.data;
			const modules = Array.isArray(data?.modules) ? data.modules : [];
			const enabled = data?.plugin?.enabled !== false;
			const readyCount = modules.filter((module) => module.status?.ready === true).length;
			const errorCount = modules.filter((module) => module.status?.sign === "error").length;
			const patchCount = modules.filter((module) => module.patch !== null).length;
			const masterNotice = state.notices.master;
			return react.createElement("div", { className: "cp_root" },
				react.createElement("div", { className: "cp_head" },
					react.createElement("div", { className: "cp_headmain" },
						react.createElement("div", { className: "cp_title" },
							react.createElement("span", null, "DSH功能补全插件"),
							react.createElement("span", { className: "cp_badge", "data-sign": enabled ? "on" : "off" }, enabled ? "运行中" : "已暂停"),
							data?.plugin?.version ? react.createElement("span", { className: "cp_key" }, `v${data.plugin.version}`) : null
						),
						react.createElement("div", { className: "cp_sub" }, "自动压缩 · 自动继续 · 视觉桥 · 推理等级，一个面板管全部；插件配置统一保存，即时生效。")
					),
					react.createElement("div", { className: "cp_headtrail" },
						react.createElement("button", {
							type: "button", className: "cp_btn",
							onClick: () => props.refresh(),
							title: "重新读取各模块状态"
						}, state.loading ? "读取中…" : "刷新"),
						react.createElement(Switch, {
							checked: enabled,
							disabled: state.busy.master === true,
							onChange: (next) => props.setMaster(next),
							label: enabled ? "总开关开" : "总开关关"
						})
					)
				),
				react.createElement("div", { className: "cp_chips" },
					react.createElement("span", { className: "cp_chip", "data-tone": "ok" }, react.createElement("b", null, String(readyCount)), "/", String(modules.length), " 个模块就绪"),
					errorCount > 0
						? react.createElement("span", { className: "cp_chip", "data-tone": "err" }, react.createElement("b", null, String(errorCount)), " 个异常")
						: react.createElement("span", { className: "cp_chip", "data-tone": "ok" }, "无异常"),
					patchCount > 0 ? react.createElement("span", { className: "cp_chip" }, react.createElement("b", null, String(patchCount)), " 个宿主补丁") : null,
					masterNotice ? react.createElement("span", { className: "cp_chip", "data-tone": masterNotice.tone === "err" ? "err" : "ok" }, masterNotice.text) : null
				),
				state.error ? react.createElement("div", { className: "cp_empty" }, `状态读取失败：${state.error}`) : null,
				modules.length === 0 && !state.error
					? react.createElement("div", { className: "cp_empty" }, state.loading ? "正在读取模块…" : "宿主没有返回任何模块")
					: react.createElement("div", { className: "cp_list" }, modules.map((module, index) => react.createElement(ModuleCard, {
						key: module.id,
						module,
						state,
						controller: props,
						defaultOpen: index === 0
					}))),
				react.createElement("div", { className: "cp_foot" },
					react.createElement("span", null, data?.namespace ? `命名空间 ${data.namespace}` : "complugin"),
					react.createElement("span", { className: "cp_spacer" }),
					react.createElement("span", null, state.updatedAt > 0 ? `状态更新于 ${new Date(state.updatedAt).toLocaleTimeString()}` : "尚未取到状态")
				)
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			const controller = new CompluginController();
			controller.start();
			ctx.effect(() => () => { controller.dispose(); }, "complugin: panel controller");
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					key: NAMESPACE,
					inject: () => controller.inject()
				}, CompluginPanel);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
