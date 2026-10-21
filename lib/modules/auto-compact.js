/**
 * dsh-auto-compact — host half.
 *
 * Watches context pressure and forces an automatic compaction before the
 * window runs out, so a long-running session survives and keeps working.
 *
 * ── Why this shape (v4, command-channel architecture) ─────────────────────
 *
 * DSH 0.1.5-rc.2 splits the planes:
 *
 *   - The compaction ENGINE (`ctx.compaction`) is a per-preset realm service
 *     (`dsh-web-app` disables the host-plane `compaction-basic` row; each
 *     agent preset mounts its own inside an isolated realm group). A host
 *     plugin CANNOT reach `ctx.compaction` directly.
 *   - The COMMAND registry (`ctx.commands`) IS a host-plane service whose
 *     `ScopedLayers` resolve per-agent command definitions: the preset
 *     realm's `command-compact` row registers `/compact` through the
 *     command-injected child of the agent context, and its handler closure
 *     carries the realm's `ctx.compaction`.
 *
 * So the force action rides the OFFICIAL command channel:
 * `ctx.commands.execute(agent, "/compact", [], signal)`. The handler runs in
 * the realm (correct `ctx.compaction`, correct pruner, correct lock
 * discipline via `agent.runMaintenance`), and the session log records
 * `command/run` + `command/done` so the compaction is visible in the UI.
 *
 * The native realm engine still auto-compacts at 80% between steps
 * (constructor-frozen `thresholdRatio`); that path stays untouched as the
 * in-turn protection net. This plugin adds the user-configurable layer on
 * top: a READY band that only announces, and a FORCE band that compacts at
 * the turn boundary through `/compact` (idle-only by construction — the
 * engine's own maintenance lock refuses to run while work is queued, which
 * we treat as "defer to the next safe point", never as an error).
 *
 * ── Hard fences ───────────────────────────────────────────────────────────
 *
 *  1. Never fails a turn: every hook body is fully guarded; failures log,
 *     disarm for that session, and pass control on.
 *  2. Optional services degrade, never crash: only `agents` is a hard
 *     inject; settings/commands/tokenMeter/llm are injected dynamically —
 *     a host missing them gets a logged notice and an inert-but-alive row.
 *  3. Anti-thrash: one forced compaction per session per `minIntervalMs`;
 *     ready-state changes only log once per crossing.
 *  4. Subagents are excluded by default.
 *  5. Unknown capacity (undeclared adapter contextWindow and no manual
 *     override) disables ratio math for that session — warned once, never
 *     guessed.
 *  6. Never interrupts a running turn: force only fires after `turn/end`
 *    with the agent settling; a busy outcome defers, it never pushes.
 *
 * @module auto-compact
 */
import z from "@deepseek-ai/schemastery";
import { defineModule } from "../core/registry.js";

/** Cordis plugin name (must match the loader row id in cordis.patch.yml). */
const name = "auto-compact";

/** Hard host requirements: only the agent registry. */
const inject = ["agents"];

/** Settings namespace this plugin owns. */
const NAMESPACE = "auto-compact";

/** Defaults; the loader row's `config` is the settings `base` layer over these. */
const DEFAULTS = Object.freeze({
	enabled: true,
	contextWindowTokens: 0,
	readyRatio: 0.8,
	forceRatio: 0.85,
	includeSubagents: false,
	notify: true,
	minIntervalMs: 30000
});

/** Settings schema for the `auto-compact` namespace (also validates row config). */
const SettingsSchema = z.object({
	enabled: z.boolean().default(DEFAULTS.enabled),
	contextWindowTokens: z.natural().min(0).max(10_000_000).default(DEFAULTS.contextWindowTokens),
	readyRatio: z.number().min(0.01).max(1).default(DEFAULTS.readyRatio),
	forceRatio: z.number().min(0.01).max(1).default(DEFAULTS.forceRatio),
	includeSubagents: z.boolean().default(DEFAULTS.includeSubagents),
	notify: z.boolean().default(DEFAULTS.notify),
	minIntervalMs: z.natural().min(0).max(3_600_000).default(DEFAULTS.minIntervalMs)
});

/** Render any thrown value as a log-safe message. */
function renderThrown(value) {
	return value instanceof Error ? value.message : String(value);
}

/** One session's pressure bookkeeping. */
function freshState() {
	return {
		/** Whether the ready threshold has been announced for the current climb. */
		ready: false,
		/** Whether the ready log line has fired for the current climb. */
		readyLogged: false,
		/** Pending turn-end deferred check timer, cancelled on disposal. */
		deferTimer: undefined,
		/** Last successful forced-compaction timestamp (ms since epoch). */
		lastForceTs: 0,
		/** One-shot latches so a missing capability logs exactly once per session. */
		warnedNoCapacity: false,
		warnedNoService: false,
		warnedNoCommand: false
	};
}

/**
 * Pressure decision — pure, exported for unit tests.
 *
 * @param usedTokens - current request pressure from the token meter.
 * @param capacityTokens - context window in tokens (>0), or 0 when unknown.
 * @param config - the live resolved settings document.
 * @param state - the session's mutable bookkeeping.
 * @param now - current timestamp (ms since epoch).
 * @returns the action to take for this measurement.
 */
function decide(usedTokens, capacityTokens, config, state, now) {
	if (!config.enabled) return { kind: "idle", updatedReady: state.ready };
	if (capacityTokens === 0) return { kind: "idle", updatedReady: state.ready };
	const forceTokens = capacityTokens * config.forceRatio;
	const readyTokens = capacityTokens * config.readyRatio;

	if (usedTokens >= forceTokens) {
		// Anti-thrash: a compaction that just ran frees the head; give the
		// session time to settle before forcing another one.
		if (now - state.lastForceTs < config.minIntervalMs) return { kind: "cooldown", updatedReady: true };
		return { kind: "force", updatedReady: true };
	}
	if (usedTokens >= readyTokens) return { kind: "ready", updatedReady: true };
	return { kind: "idle", updatedReady: false };
}

/**
 * Install the automatic context-pressure engine.
 * @param ctx - host context with the `agents` service injected.
 * @param config - loader row config; the settings `base` layer.
 */
function apply(ctx, config = {}) {
	ctx.logger.info("auto-compact: plugin active");

	/** Live configuration; falls back to row config without a settings surface. */
	let live = Object.freeze({ ...DEFAULTS, ...config });

	const resolveRow = () => {
		try {
			return Object.freeze(SettingsSchema({ ...DEFAULTS, ...config }));
		} catch (error) {
			ctx.logger.warn(`auto-compact: invalid row config, using defaults: ${renderThrown(error)}`);
			return Object.freeze({ ...DEFAULTS });
		}
	};
	live = resolveRow();

	if (live.readyRatio > live.forceRatio) {
		ctx.logger.warn(`auto-compact: readyRatio (${live.readyRatio}) must be <= forceRatio (${live.forceRatio}); widening ready to force`);
		live = Object.freeze({ ...live, readyRatio: Math.min(live.readyRatio, live.forceRatio) });
	}

	// The settings namespace is the shared surface: the browser card writes
	// through DSH's own settings scope, so a panel edit needs no bespoke
	// HTTP route, survives a restart, and wins over the row config.
	try {
		ctx.inject(["settings"], (sctx) => {
			const scope = sctx.settings.register(NAMESPACE, SettingsSchema, { base: resolveRow() });
			live = scope.get();
			scope.watch(() => {
				let next = scope.get();
				if (next.readyRatio > next.forceRatio) next = { ...next, readyRatio: next.forceRatio };
				live = Object.freeze(next);
				ctx.logger.info(`auto-compact: configuration changed (enabled=${live.enabled}, ready=${live.readyRatio}, force=${live.forceRatio})`);
			});
		});
	} catch (error) {
		ctx.logger.warn(`auto-compact: settings namespace unavailable, using row config: ${renderThrown(error)}`);
	}

	/**
	 * Optional capability bundle. Every field stays undefined when the host
	 * does not mount the service; the engine degrades and logs once.
	 */
	const caps = {
		commands: undefined,
		tokenMeter: undefined,
		llm: undefined
	};
	for (const service of ["commands", "tokenMeter", "llm"]) {
		try {
			ctx.inject([service], (sctx) => {
				caps[service] = sctx[service];
				ctx.logger.info(`auto-compact: ${service} service available`);
			});
		} catch (error) {
			ctx.logger.warn(`auto-compact: ${service} service unavailable: ${renderThrown(error)}`);
		}
	}

	/** Routed capacity cache: model info is static per provider/model pair. */
	const capacityCache = new Map();

	/**
	 * Resolve the context window for one routed target.
	 * @returns capacity in tokens, or 0 when it cannot be established.
	 */
	async function capacityOf(target, signal) {
		const key = `${target.provider}\0${target.model}`;
		if (capacityCache.has(key)) return capacityCache.get(key);
		let window = 0;
		const info = await caps.llm.resolveModelInfo(target.provider, target.model, signal);
		if (typeof info?.context?.contextWindow === "number" && Number.isInteger(info.context.contextWindow)) {
			window = info.context.contextWindow;
		}
		capacityCache.set(key, window);
		return window;
	}

	/** Per-agent bookkeeping, keyed by the live agent handle. */
	const states = new Map();

	/** Read (or create) the bookkeeping for one live agent. */
	function stateFor(agent) {
		let state = states.get(agent);
		if (state === undefined) {
			state = freshState();
			states.set(agent, state);
		}
		return state;
	}

	/** Whether this agent is in scope. */
	function inScope(agent) {
		if (live.includeSubagents) return true;
		return ctx.agents.roots().includes(agent);
	}

	/** Resolve the durable routed target (provider/model) for a session. */
	function routedTargetOf(session) {
		const config = session.requestHeader()?.config;
		if (config === undefined || !config.provider || !config.model) return undefined;
		return { provider: config.provider, model: config.model };
	}

	/**
	 * Measure one agent and decide the action.
	 * @returns the decision bundle, or null when pressure math is unavailable.
	 */
	async function measureAndDecide(agent, state, signal) {
		const target = routedTargetOf(agent.session);
		if (target === undefined) return null;
		const measurement = caps.tokenMeter.measure(agent.session);
		const capacity = live.contextWindowTokens > 0
			? live.contextWindowTokens
			: await capacityOf(target, signal);
		if (capacity === 0) {
			if (!state.warnedNoCapacity) {
				state.warnedNoCapacity = true;
				ctx.logger.warn(
					`auto-compact: no context capacity for ${target.provider}/${target.model}; `
					+ `set contextWindowTokens in Settings -> Plugins -> auto-compact`,
				);
			}
			return null;
		}
		const decision = decide(measurement.totalTokens, capacity, live, state, Date.now());
		return { decision, measurement, capacity, target };
	}

	/** Complete capability set required for any action. */
	function capabilitiesReady(agent, state) {
		if (caps.commands === undefined || caps.tokenMeter === undefined || caps.llm === undefined) {
			if (!state.warnedNoService) {
				state.warnedNoService = true;
				ctx.logger.warn("auto-compact: commands/tokenMeter/llm service missing — auto-compaction disabled for this host");
			}
			return false;
		}
		// Liveness: the agent may have been disposed mid-observation.
		return ctx.agents.get(agent.id) === agent;
	}

	/**
	 * Force one compaction through the official command channel. The preset
	 * realm's `/compact` handler runs under the engine's own maintenance
	 * lock; a busy engine means queued work owns the agent — defer.
	 */
	async function forceCompaction(agent, state) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 120_000);
		timer.unref?.();
		try {
			const execution = await caps.commands.execute(agent, "/compact", [], controller.signal);
			if (execution === undefined) {
				// The preset did not register /compact (e.g. a minimal preset).
				if (!state.warnedNoCommand) {
					state.warnedNoCommand = true;
					ctx.logger.warn(`auto-compact: /compact is not registered for "${agent.id}" (preset without compaction); auto-compaction inactive for it`);
				}
				return false;
			}
			state.lastForceTs = Date.now();
			state.ready = false;
			state.readyLogged = false;
			if (execution.result.kind === "success") {
				ctx.logger.info(`auto-compact: forced /compact on "${agent.id}": ${execution.result.text ?? "done"}`);
			} else {
				ctx.logger.warn(`auto-compact: /compact on "${agent.id}" settled as error: ${execution.result.text}`);
			}
			return true;
		} catch (error) {
			const message = renderThrown(error);
			if (/busy/i.test(message)) {
				ctx.logger.info(`auto-compact: "${agent.id}" busy at force time; deferring to the next safe point`);
				return false;
			}
			ctx.logger.warn(`auto-compact: force failed for "${agent.id}": ${message}`);
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	ctx.effect(function* () {
		ctx.on("agent/disposed", ({ agent }) => {
			const state = states.get(agent);
			if (state !== undefined && state.deferTimer !== undefined) clearTimeout(state.deferTimer);
			states.delete(agent);
		});

		// During-turn observation: announce the ready band once per climb; a
		// force decision raised here is handled at the turn boundary, never
		// by interrupting the running turn.
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			try {
				if (!signal.aborted && live.enabled && inScope(agent)) {
					const state = stateFor(agent);
					if (capabilitiesReady(agent, state)) {
						const observed = await measureAndDecide(agent, state, signal);
						if (observed !== null) {
							state.ready = observed.decision.updatedReady;
							if (observed.decision.kind === "ready" && !state.readyLogged) {
								state.readyLogged = true;
								if (live.notify) ctx.logger.info(
									`auto-compact: READY at ${observed.measurement.totalTokens}/${observed.capacity} tokens `
									+ `(${Math.round(observed.measurement.totalTokens / observed.capacity * 100)}%) for "${agent.id}"`,
								);
							} else if (observed.decision.kind === "idle") {
								state.readyLogged = false;
							}
						}
					}
				}
			} catch (error) {
				ctx.logger.warn(`auto-compact: pressure check threw for "${agent.id}": ${renderThrown(error)}`);
			}
			return next();
		});

		// Turn-boundary force: the turn has ended; after a settle delay the
		// engine's maintenance channel is free, so `/compact` runs without
		// disturbing anything. Busy means queued work claimed the agent
		// first — defer silently to the next boundary.
		ctx.on("session/event", (session, event) => {
			if (event.type !== "turn/end") return;
			const agent = ctx.agents.get(session.id);
			if (agent === undefined || !live.enabled || !inScope(agent)) return;
			const state = stateFor(agent);
			if (!capabilitiesReady(agent, state)) return;
			if (state.deferTimer !== undefined) clearTimeout(state.deferTimer);
			const timer = setTimeout(() => {
				state.deferTimer = undefined;
				void (async () => {
					try {
						// The agent may have started a new turn while the
						// settle delay elapsed; in that case the next
						// boundary owns the decision.
						if (agent.status !== "idle") return;
						if (!capabilitiesReady(agent, state)) return;
						const observed = await measureAndDecide(agent, state, undefined);
						if (observed === null) return;
						state.ready = observed.decision.updatedReady;
						if (observed.decision.kind !== "force") return;
						if (live.notify) ctx.logger.info(
							`auto-compact: FORCE at ${observed.measurement.totalTokens}/${observed.capacity} tokens `
							+ `(${Math.round(observed.measurement.totalTokens / observed.capacity * 100)}%) for "${agent.id}" (idle boundary)`,
						);
						await forceCompaction(agent, state);
					} catch (error) {
						ctx.logger.warn(`auto-compact: idle check threw for "${agent.id}": ${renderThrown(error)}`);
					}
				})();
			}, 500);
			timer.unref?.();
			state.deferTimer = timer;
		});

		yield () => {
			for (const state of states.values()) {
				if (state.deferTimer !== undefined) clearTimeout(state.deferTimer);
			}
			states.clear();
		};
	}, "auto-compact lifecycle");
}

export { apply, inject, name, DEFAULTS, SettingsSchema, NAMESPACE, decide, freshState };

/** Module declaration consumed by `complugin`. */
export default defineModule({
	id: "autoCompact",
	kind: "hook",
	order: 10,
	title: "自动压缩",
	summary: "上下文压力达到阈值时自动压缩，会话不断、工作继续。",
	legacy: "auto-compact",
	inject: ["agents"],
	docs: "达到「准备阈值」只提示，达到「强制阈值」在回合结束的空闲点通过官方 /compact 命令压缩，绝不打断进行中的回合。",
	fields: [
		{
			key: "enabled",
			label: "启用自动压缩",
			type: "switch",
			group: "basic",
			default: true,
			hint: "总开关。开启后自动监控上下文压力，达到强制阈值就通过官方压缩引擎自动压缩，会话不断。"
		},
		{
			key: "includeSubagents",
			label: "包含子 agent",
			type: "switch",
			group: "basic",
			default: false,
			hint: "同时监控子 agent 会话。默认关：父编排器管理子会话生命周期。"
		},
		{
			key: "notify",
			label: "事件提示",
			type: "switch",
			group: "basic",
			default: true,
			hint: "在日志与面板中提示准备/强制事件。"
		},
		{
			key: "contextWindowTokens",
			label: "上下文窗口",
			type: "number",
			group: "tuning",
			default: 0,
			min: 0,
			max: 10000000,
			step: 1000,
			unit: "tokens",
			hint: "填 0 = 自动跟随当前路由模型声明的容量（推荐）。例如 200K 窗口填 200000。"
		},
		{
			key: "readyRatio",
			label: "准备阈值",
			type: "number",
			group: "tuning",
			default: 0.8,
			min: 0.01,
			max: 1,
			step: 0.01,
			hint: "占用比例，0.8 = 剩余 20% 时进入准备态并提示。到达后仅记录与提示，不压缩。"
		},
		{
			key: "forceRatio",
			label: "强制阈值",
			type: "number",
			group: "tuning",
			default: 0.85,
			min: 0.01,
			max: 1,
			step: 0.01,
			hint: "占用比例，0.85 = 剩余 15% 时强制压缩。在回合结束的空闲点执行。"
		},
		{
			key: "minIntervalMs",
			label: "压缩最小间隔",
			type: "number",
			group: "advanced",
			default: 30000,
			min: 0,
			max: 3600000,
			step: 1000,
			unit: "ms",
			hint: "同一会话两次强制压缩的最小间隔（防抖），默认 30000。"
		}
	],
	mount({ ctx, config }) {
		apply(ctx, config());
		return {
			status: () => {
				const current = config();
				return {
					ready: current.enabled !== false,
					badge: current.enabled === false ? "已停用" : "监控中",
					line: current.enabled === false
						? "开关已关闭，不再监控上下文压力"
						: `准备 ${Math.round(current.readyRatio * 100)}% / 强制 ${Math.round(current.forceRatio * 100)}%`
				};
			}
		};
	}
});
