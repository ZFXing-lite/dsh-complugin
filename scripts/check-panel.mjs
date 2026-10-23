/**
 * Headless end-to-end check of the browser half against a live DSH instance.
 *
 * Boots headless Chrome over CDP, drives the real UI with real pointer input
 * (settings dialog → 插件 → 功能补全 tab), and reports:
 *  - uncaught exceptions / console errors from the page
 *  - the tab row, so the panel's placement is verifiable
 *  - whether the controls actually respond: a sub-switch must flip, the save
 *    button must wake up, and the row label must operate its own control
 *  - the update chip's state
 *
 * This is the check that would have caught 1.0.0's inert panel: every control
 * rendered, nothing was clickable, because the injected API was missing the
 * value resolvers.
 *
 * Usage: node check-panel.mjs <url-with-token> [chrome-path] [cdp-port]
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const url = process.argv[2];
// Accept the port in either arg slot: [chrome-path] [port] or just [port].
let chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let port = 9223;
for (const arg of process.argv.slice(3)) {
	if (/^\d+$/u.test(arg)) port = Number(arg);
	else chromePath = arg;
}
if (!url) throw new Error("usage: node check-panel.mjs <url-with-token> [chrome-path] [cdp-port]");

const profile = `${process.env.TEMP ?? "/tmp"}\\cdp-complugin-${Date.now()}`;
const chrome = spawn(chromePath, [
	"--headless=new",
	`--remote-debugging-port=${port}`,
	`--user-data-dir=${profile}`,
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-gpu",
	"--window-size=1440,1200",
	"about:blank"
], { stdio: "ignore" });

async function targets() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`);
			const list = await response.json();
			const page = list.find((entry) => entry.type === "page");
			if (page !== undefined) return page;
		} catch {
			// chrome not listening yet
		}
		await sleep(500);
	}
	throw new Error("chrome did not expose a page target");
}

const page = await targets();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const problems = [];
const consoleLines = [];
let nextId = 1;

function send(method, params = {}) {
	const id = nextId++;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`CDP timeout: ${method}`));
		}, 25000);
		pending.set(id, (value) => {
			clearTimeout(timer);
			resolve(value);
		});
	});
}

// A hung check is worse than a failing one: force a verdict after 150s.
const trace = [];
const mark = (step) => {
	trace.push(`${new Date().toISOString().slice(14, 22)} ${step}`);
};
const watchdog = setTimeout(() => {
	console.log(JSON.stringify({ ok: false, fatal: "watchdog after 150s", trace, problems }, null, 2));
	try { socket.close(); } catch { /* gone */ }
	chrome.kill();
	process.exit(1);
}, 150000);
watchdog.unref?.();
process.on("uncaughtException", (error) => {
	console.log(JSON.stringify({ ok: false, fatal: String(error?.message ?? error), trace, problems }, null, 2));
	try { socket.close(); } catch { /* gone */ }
	chrome.kill();
	process.exit(1);
});

socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id !== undefined) {
		pending.get(message.id)?.(message.result);
		pending.delete(message.id);
		return;
	}
	if (message.method === "Runtime.exceptionThrown") {
		const detail = message.params.exceptionDetails;
		problems.push(`exception: ${detail.exception?.description ?? detail.text}`);
	}
	if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
		problems.push(`log: ${message.params.entry.text}`);
	}
	if (message.method === "Runtime.consoleAPICalled") {
		const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
		consoleLines.push(`${message.params.type}: ${text}`);
		if (message.params.type === "error") problems.push(`console: ${text}`);
	}
});

await new Promise((resolve) => socket.addEventListener("open", resolve));
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", { url });
mark("navigated");
await sleep(9000);
mark("page settled");

async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result?.exceptionDetails) problems.push(`eval: ${result.exceptionDetails.text}`);
	return result?.result?.value;
}

// Shadow-DOM aware traversal plus the two primitives the flow needs.
await evaluate(String.raw`
window.__all = () => {
	const out = [];
	const walk = (root) => { for (const node of root.querySelectorAll("*")) { out.push(node); if (node.shadowRoot) walk(node.shadowRoot); } };
	walk(document);
	return out;
};
window.__rect = (node) => {
	const r = node.getBoundingClientRect();
	return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
};
window.__visible = (text, tag) => window.__all()
	.filter((n) => (!tag || n.tagName === tag) && (n.textContent ?? "").trim() === text)
	.map((n) => window.__rect(n))
	.filter((r) => r.w > 4 && r.h > 4);
window.__panel = () => window.__all().find((n) => n.classList && n.classList.contains("cp_root"));
window.__controls = () => {
	const root = window.__panel();
	if (!root) return null;
	const owned = (n) => n.closest(".cp_root") === root;
	return {
		switches: window.__all().filter((n) => owned(n) && n.tagName === "INPUT" && n.type === "checkbox").map((n) => n.checked),
		save: window.__all().filter((n) => owned(n) && n.tagName === "BUTTON" && (n.textContent ?? "").trim() === "保存").map((n) => n.disabled),
		dirtyMarks: window.__all().filter((n) => owned(n)).map((n) => (n.textContent ?? "").trim()).filter((t) => t === "有未保存的改动" || t === "改动未保存").length,
		chips: window.__all().filter((n) => owned(n) && n.classList && n.classList.contains("cp_chip")).map((n) => (n.textContent ?? "").trim())
	};
};
true;`);

async function clickAt(x, y) {
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

/** Click the first visible element whose text matches; false when absent. */
async function clickText(text, tag) {
	const hits = await evaluate(`window.__visible(${JSON.stringify(text)}, ${JSON.stringify(tag ?? null)})`);
	if (!Array.isArray(hits) || hits.length === 0) return false;
	await clickAt(hits[0].x, hits[0].y);
	await sleep(1000);
	return true;
}

// A foreign plugin may hold a first-run notice over the page; drop it so the
// pointer input reaches the app.
await evaluate(String.raw`(() => {
	for (const mask of window.__all().filter((n) => n.classList && String(n.className).includes("dshp-auth-mask"))) mask.remove();
	return true;
})()`);

const opened = await evaluate(`(() => {
	const button = window.__all().find((n) => n.tagName === "BUTTON" && n.getAttribute("aria-label") === "设置");
	if (!button) return null;
	return window.__rect(button);
})()`);
if (opened) {
	await clickAt(opened.x, opened.y);
	await sleep(1200);
}
const enteredPlugins = await clickText("插件");
await sleep(400);
const enteredTab = await clickText("功能补全", "BUTTON") || await clickText("功能补全");
mark(`entered tab=${enteredTab}`);

const tabs = await evaluate(`(() => window.__all()
	.filter((n) => n.getAttribute && n.getAttribute("role") === "tab")
	.map((n) => ({ text: (n.textContent ?? "").trim(), selected: n.getAttribute("aria-selected") })))()`);

const collapsedInputs = await evaluate(`(() => {
	const root = window.__panel();
	if (!root) return null;
	return window.__all().filter((n) => n.closest(".cp_root") === root && n.tagName === "INPUT").length;
})()`);
const collapsedOutcome = await evaluate(`(() => window.__all().filter((n) => n.classList && n.classList.contains("cp_modhead")).map((n) => (n.textContent ?? "").trim()))()`);

// Expand the first module card — the tab starts as a collapsed accordion.
const firstCard = await evaluate(`(() => { const h = window.__all().find((n) => n.classList && n.classList.contains("cp_modhead")); return h ? window.__rect(h) : null; })()`);
mark("expanding first card");
if (firstCard) {
	await clickAt(firstCard.x, firstCard.y);
	await sleep(700);
}

const before = await evaluate("window.__controls()");

// Operate the first sub-switch (the master switch is index 0).
let switchFlipped = null;
const tracks = await evaluate(`(() => {
	const root = window.__panel();
	if (!root) return [];
	return window.__all().filter((n) => n.closest(".cp_root") === root && n.classList && n.classList.contains("cp_track")).map((n) => window.__rect(n));
})()`);
if (Array.isArray(tracks) && tracks.length > 1) {
	await clickAt(tracks[1].x, tracks[1].y);
	await sleep(700);
	const after = await evaluate("window.__controls()");
	switchFlipped = JSON.stringify(before?.switches) !== JSON.stringify(after?.switches);
}

// The field name must operate its own control as well.
const labels = await evaluate(`(() => {
	const root = window.__panel();
	if (!root) return [];
	return window.__all().filter((n) => n.closest(".cp_root") === root && n.classList && n.classList.contains("cp_label")).map((n) => window.__rect(n));
})()`);
let labelWorks = null;
if (Array.isArray(labels) && labels.length > 2) {
	const beforeLabel = await evaluate("window.__controls()");
	await clickAt(labels[2].x, labels[2].y);
	await sleep(700);
	const afterLabel = await evaluate("window.__controls()");
	labelWorks = JSON.stringify(beforeLabel?.switches) !== JSON.stringify(afterLabel?.switches);
}

const after = await evaluate("window.__controls()");

// ── 视觉桥 end-to-end: 拉取模型 → chips → 点选填入 → 测试视觉 ────────────────
// Opens the 视觉桥 card (accordion closes the other), runs the two actions that
// had no visible feedback before, and reads the outcome back from the DOM.
// Real pointer events are proven working on switches, but a click that must hit
// a card head lower in the scrollable dialog can land on the wrong element once
// the layout shifts — so every click here verifies its effect and falls back to
// a DOM-level click (which React sees identically).
async function clickCard(title) {
	const head = await evaluate(`(() => {
		const root = window.__panel();
		if (!root) return null;
		const head = window.__all().find((n) => n.closest(".cp_root") === root && n.classList && n.classList.contains("cp_modhead") && (n.textContent ?? "").includes(${JSON.stringify(title)}));
		if (!head) return null;
		head.scrollIntoView({ block: "center" });
		return window.__rect(head);
	})()`);
	if (!head) return false;
	await sleep(250);
	await clickAt(head.x, head.y);
	await sleep(600);
	let open = await evaluate(`(() => {
		const root = window.__panel();
		const card = window.__all().find((n) => n.closest(".cp_root") === root && n.classList.contains("cp_mod") && (n.textContent ?? "").includes(${JSON.stringify(title)}));
		return card ? card.getAttribute("data-open") === "true" : false;
	})()`);
	if (!open) {
		await evaluate(`(() => {
			const root = window.__panel();
			const head = window.__all().find((n) => n.closest(".cp_root") === root && n.classList && n.classList.contains("cp_modhead") && (n.textContent ?? "").includes(${JSON.stringify(title)}));
			if (head) head.click();
			return true;
		})()`);
		await sleep(600);
		open = await evaluate(`(() => {
			const root = window.__panel();
			const card = window.__all().find((n) => n.closest(".cp_root") === root && n.classList.contains("cp_mod") && (n.textContent ?? "").includes(${JSON.stringify(title)}));
			return card ? card.getAttribute("data-open") === "true" : false;
		})()`);
	}
	return open;
}

/** Click an action button inside the currently open card by label (verified). */
async function clickAction(label) {
	const found = await evaluate(`(() => {
		const root = window.__panel();
		if (!root) return null;
		const b = window.__all().find((n) => n.closest(".cp_root") === root && n.tagName === "BUTTON" && (n.textContent ?? "").trim() === ${JSON.stringify(label)});
		if (!b || b.disabled) return null;
		b.scrollIntoView({ block: "center" });
		return window.__rect(b);
	})()`);
	if (!found) return false;
	await sleep(250);
	await clickAt(found.x, found.y);
	await sleep(300);
	const started = await evaluate(`(() => window.__complugin ? Array.from(window.__complugin.busy.keys()).length > 0 : false)()`);
	if (started) return true;
	return await evaluate(`(() => {
		const root = window.__panel();
		const b = window.__all().find((n) => n.closest(".cp_root") === root && n.tagName === "BUTTON" && (n.textContent ?? "").trim() === ${JSON.stringify(label)});
		if (!b || b.disabled) return false;
		b.click();
		return true;
	})()`);
}

async function waitFor(expression, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await evaluate(expression);
		if (value) return value;
		await sleep(700);
	}
	return null;
}

const visionOpened = await clickCard("视觉桥");
let visionModels = null;
let visionChipFilled = null;
let visionTestText = null;
let visionError = null;
let visionClick = null;
if (visionOpened) {
	mark("vision pull click");
	const clicked = await clickAction("拉取模型");
	await sleep(400);
	// Did the click even reach the action? busy must name it within a moment.
	visionClick = { clicked, busy: await evaluate(`(() => window.__complugin ? Array.from(window.__complugin.busy.keys()) : null)()`) };
	if (!clicked) {
		visionClick.dump = await evaluate(`(() => {
			const root = window.__panel();
			if (!root) return null;
			return {
				openCards: window.__all().filter((n) => n.closest(".cp_root") === root && n.classList.contains("cp_mod")).map((n) => ({ open: n.getAttribute("data-open"), head: (n.querySelector(".cp_modhead")?.textContent ?? "").trim().slice(0, 40) })),
				buttons: window.__all().filter((n) => n.closest(".cp_root") === root && n.tagName === "BUTTON").map((n) => (n.textContent ?? "").trim().slice(0, 20))
			};
		})()`);
	}
	if (clicked) {
		const chips = await waitFor(`(() => {
			const root = window.__panel();
			const chips = window.__all().filter((n) => n.closest(".cp_root") === root && n.classList && n.classList.contains("cp_modelchip"));
			if (chips.length > 0) return chips.slice(0, 8).map((n) => (n.textContent ?? "").trim());
			const err = window.__all().find((n) => n.closest(".cp_root") === root && n.classList && n.classList.contains("cp_outcome") && n.getAttribute("data-tone") === "err");
			if (err) return { error: (err.textContent ?? "").trim().slice(0, 160) };
			return null;
		})()`);
		if (Array.isArray(chips)) {
			visionModels = chips;
			// Click the first chip: it must draft into the model field.
			const chipRect = await evaluate(`(() => {
				const root = window.__panel();
				const c = window.__all().find((n) => n.closest(".cp_root") === root && n.classList && n.classList.contains("cp_modelchip"));
				return c ? { ...window.__rect(c), text: (c.textContent ?? "").trim() } : null;
			})()`);
			if (chipRect) {
				await clickAt(chipRect.x, chipRect.y);
				await sleep(500);
				const typed = await evaluate(`(() => {
					const root = window.__panel();
					const input = window.__all().find((n) => n.closest(".cp_root") === root && n.tagName === "INPUT" && n.id === "cp_visionBridge_model");
					return input ? input.value : null;
				})()`);
				visionChipFilled = typed === chipRect.text;
			}
			// Discard the draft so the check leaves no writes behind.
			await clickAction("丢弃");
			await sleep(400);
		} else if (chips && chips.error) {
			visionError = chips.error;
		}
	}
	if (await clickAction("测试视觉")) {
		mark("vision test clicked, waiting pre");
		const text = await waitFor(`(() => {
			const root = window.__panel();
			const pre = window.__all().find((n) => n.closest(".cp_root") === root && n.classList && n.classList.contains("cp_pre"));
			return pre ? (pre.textContent ?? "").trim().slice(0, 120) : null;
		})()`, 40000);
		visionTestText = text;
		mark("vision test done");
	}
}

mark("closing");
socket.close();
chrome.kill();

const report = {
	url: url.replace(/token=[^&]+/, "token=***"),
	settingsOpened: opened !== null,
	pluginsSectionEntered: enteredPlugins,
	panelTabEntered: enteredTab,
	tabs,
	panelPresent: before !== null,
	cardsCollapsedByDefault: collapsedInputs !== null && collapsedInputs <= 1,
	cardsListed: Array.isArray(collapsedOutcome) ? collapsedOutcome.length : 0,
	switchesBefore: before?.switches ?? null,
	switchesAfter: after?.switches ?? null,
	saveEnabledAfterChange: after?.save?.length === 0 || after?.save?.[0] === false,
	dirtyMarkers: after?.dirtyMarks ?? 0,
	updateChip: (before?.chips ?? []).find((text) => /更新|最新|新版本|git/.test(text)) ?? null,
	switchResponds: switchFlipped,
	labelResponds: labelWorks,
	vision: {
		click: visionClick,
		cardOpened: visionOpened,
		modelsSample: Array.isArray(visionModels) ? visionModels.slice(0, 4) : null,
		modelsCount: Array.isArray(visionModels) ? visionModels.length : 0,
		chipFillsModelField: visionChipFilled,
		testText: visionTestText,
		error: visionError
	},
	problems: problems.slice(0, 12),
	consoleTail: consoleLines.slice(-8)
};
report.ok = report.panelPresent
	&& report.cardsCollapsedByDefault
	&& report.switchResponds === true
	&& report.labelResponds === true
	&& report.vision.error === null
	&& report.vision.modelsCount > 0
	&& report.vision.chipFillsModelField === true
	&& report.vision.testText !== null
	&& report.problems.length === 0;
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
