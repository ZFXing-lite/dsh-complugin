/**
 * dsh-complugin — the panel API.
 *
 * One generic endpoint family serves every module, present and future:
 *
 * | route                        | meaning                                    |
 * |------------------------------|--------------------------------------------|
 * | `GET  /api/complugin/status` | whole panel: modules, field specs, status  |
 * | `POST /api/complugin/master` | global on/off                              |
 * | `POST /api/complugin/config` | write one module's fields                  |
 * | `POST /api/complugin/action` | run a module action (test, clear, apply…)  |
 * | `POST /api/complugin/patch`  | apply / revert a declared host patch       |
 * | `POST /api/complugin/update` | check GitHub for updates / pull them       |
 *
 * The browser half contains no per-module code: it renders whatever the status
 * payload describes. That is what keeps the panel honest when features are
 * added later.
 *
 * @module dsh-complugin/core/routes
 */
import { renderThrown } from "./env.js";

/** Largest request body accepted, in bytes. */
const BODY_LIMIT = 1 << 20;

/** Write one JSON response. */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}

/** Read and parse a JSON request body (empty body → `{}`). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > BODY_LIMIT) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	const parsed = JSON.parse(text);
	return parsed !== null && typeof parsed === "object" ? parsed : {};
}

/**
 * Mount the panel API.
 *
 * @param {object} options - `{ ctx, logger, api }` where `api` supplies
 *   `status()`, `setMaster(enabled)`, `updateModule(id, values)`,
 *   `runAction(id, action)`, `runPatch(id, action)`, `update(action)`.
 * @returns {void}
 */
export function registerRoutes(options) {
	const { ctx, logger, api } = options;
	ctx.inject(["webServer"], (sctx) => {
		const webServer = sctx.webServer;
		if (webServer === undefined || typeof webServer.register !== "function") {
			logger.warn("complugin: webServer 不可用，面板 API 未挂载");
			return;
		}
		const routes = [
			{
				path: "/api/complugin/status",
				handler: async (_req, res) => {
					try {
						sendJson(res, 200, { ok: true, ...(await api.status()) });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error) });
					}
				}
			},
			{
				path: "/api/complugin/master",
				handler: async (req, res) => {
					try {
						const body = await readJsonBody(req);
						await api.setMaster(body.enabled !== false);
						sendJson(res, 200, { ok: true, ...(await api.status()) });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error) });
					}
				}
			},
			{
				path: "/api/complugin/config",
				handler: async (req, res) => {
					try {
						const body = await readJsonBody(req);
						const id = String(body.module ?? "");
						const values = body.values !== null && typeof body.values === "object" ? body.values : {};
						const result = await api.updateModule(id, values);
						sendJson(res, 200, { ok: result.ok !== false, detail: String(result.detail ?? ""), ...(await api.status()) });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error) });
					}
				}
			},
			{
				path: "/api/complugin/action",
				handler: async (req, res) => {
					try {
						const body = await readJsonBody(req);
						const id = String(body.module ?? "");
						const action = String(body.action ?? "");
						const result = await api.runAction(id, action, body.values ?? {});
						sendJson(res, 200, { ok: result.ok !== false, detail: String(result.detail ?? ""), data: result.data ?? null, ...(await api.status()) });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error) });
					}
				}
			},
			{
				path: "/api/complugin/patch",
				handler: async (req, res) => {
					try {
						const body = await readJsonBody(req);
						const id = String(body.module ?? "");
						const action = String(body.action ?? "status");
						const result = await api.runPatch(id, action);
						sendJson(res, 200, { ok: result.ok !== false, detail: String(result.detail ?? ""), ...(await api.status()) });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error) });
					}
				}
			},
			{
				path: "/api/complugin/update",
				handler: async (req, res) => {
					try {
						const body = await readJsonBody(req);
						const action = String(body.action ?? "check");
						const result = await api.update(action);
						sendJson(res, 200, { ok: result.ok !== false, detail: String(result.detail ?? ""), ...(await api.status()) });
					} catch (error) {
						sendJson(res, 200, { ok: false, error: renderThrown(error) });
					}
				}
			}
		];

		ctx.effect(() => {
			const disposers = [];
			for (const route of routes) {
				try {
					const dispose = webServer.register({ kind: "exact", path: route.path, handler: route.handler });
					if (typeof dispose === "function") disposers.push(dispose);
				} catch (error) {
					logger.warn(`complugin: 路由 ${route.path} 挂载失败：${renderThrown(error)}`);
				}
			}
			return () => {
				for (const dispose of disposers) {
					try {
						dispose();
					} catch {
						/* already gone */
					}
				}
			};
		}, "complugin: http routes");

		logger.info("complugin: 面板 API 已挂载（/api/complugin/*）");
	});
}
