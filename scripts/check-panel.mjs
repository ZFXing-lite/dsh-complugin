/**
 * Headless verification of the browser half against a live DSH instance.
 *
 * Boots headless Chrome over CDP, loads the app, and reports:
 *  - every uncaught exception / console error from the page
 *  - whether the dsh-complugin client module registered in the module loader
 *  - whether the panel title reaches the DOM once the settings dialog is opened
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
	"--window-size=1440,1000",
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
await sleep(6000);

async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result?.exceptionDetails) problems.push(`eval: ${result.exceptionDetails.text}`);
	return result?.result?.value;
}

const loaderIds = await evaluate(`(() => {
	const loader = window.__ModuleLoader__;
	if (!loader) return null;
	const seen = new Set();
	const walk = (value) => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		for (const key of Object.keys(value)) {
			if (typeof value[key] === "string" && value[key].includes("complugin")) ids.add(value[key]);
			else walk(value[key]);
		}
	};
	const ids = new Set();
	walk(loader);
	return { keys: Object.keys(loader), mentions: [...ids] };
})()`);

const bodyMentions = await evaluate(`document.body.innerText.includes("DSH功能补全插件")`);
const settingsHints = await evaluate(`(() => {
	const text = document.body.innerText;
	return {
		hasSettings: /设置|Settings/.test(text),
		sample: text.replace(/\\s+/g, " ").slice(0, 240)
	};
})()`);

await sleep(1000);
socket.close();
chrome.kill();

console.log(JSON.stringify({
	url: url.replace(/token=[^&]+/, "token=***"),
	loader: loaderIds,
	panelTitleInDomWithoutOpeningSettings: bodyMentions,
	dom: settingsHints,
	problems: problems.slice(0, 12),
	consoleTail: consoleLines.slice(-8)
}, null, 2));
