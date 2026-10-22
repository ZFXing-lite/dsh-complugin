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
const chromePath = process.argv[3] ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = Number(process.argv[4] ?? 9223);
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
	return new Promise((resolve) => pending.set(id, resolve));
}

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
await sleep(9000);

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

const tabs = await evaluate(`(() => window.__all()
	.filter((n) => n.getAttribute && n.getAttribute("role") === "tab")
	.map((n) => ({ text: (n.textContent ?? "").trim(), selected: n.getAttribute("aria-selected") })))()`);

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

socket.close();
chrome.kill();

const report = {
	url: url.replace(/token=[^&]+/, "token=***"),
	settingsOpened: opened !== null,
	pluginsSectionEntered: enteredPlugins,
	panelTabEntered: enteredTab,
	tabs,
	panelPresent: before !== null,
	switchesBefore: before?.switches ?? null,
	switchesAfter: after?.switches ?? null,
	saveEnabledAfterChange: after?.save?.length === 0 || after?.save?.[0] === false,
	dirtyMarkers: after?.dirtyMarks ?? 0,
	updateChip: (before?.chips ?? []).find((text) => /更新|最新|新版本|git/.test(text)) ?? null,
	switchResponds: switchFlipped,
	labelResponds: labelWorks,
	problems: problems.slice(0, 12),
	consoleTail: consoleLines.slice(-8)
};
report.ok = report.panelPresent && report.switchResponds === true && report.problems.length === 0;
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
