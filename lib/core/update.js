/**
 * dsh-complugin — self update.
 *
 * The plugin ships from a plain git checkout, so updating is git's job:
 * `fetch` → compare `HEAD` with `origin/main` → `pull --ff-only` when the
 * checkout is strictly behind. Nothing is downloaded, unpacked or overwritten
 * by hand, and a local edit can never be clobbered: a diverged checkout is
 * reported, never force-reset.
 *
 * The panel never calls GitHub on its own — `status` reads this cache, and only
 * an explicit check (or the one deferred boot check) touches the network.
 *
 * @module dsh-complugin/core/update
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderThrown } from "./env.js";

/**
 * Run a child process and resolve `{ stdout, stderr }`.
 *
 * Deliberately callback-based: the host may swap `node:child_process` for a
 * facade that keeps the callback contract but drops `util.promisify.custom`,
 * and `promisify(execFile)` then resolves to the bare stdout string instead of
 * `{ stdout, stderr }` — which silently degraded every git call to an empty
 * result here.
 */
function run(file, args, options) {
	return new Promise((resolve, reject) => {
		execFile(file, args, options, (error, stdout, stderr) => {
			if (error !== null && error !== undefined) {
				reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
				return;
			}
			resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/** How long a single git call may take before it is treated as failed. */
const GIT_TIMEOUT_MS = 30_000;

/** GitHub API + raw content, used when git itself cannot reach the remote. */
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** Keep the last error line short enough for a status chip. */
function tail(text, limit = 200) {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** `owner/repo` from a package.json repository URL or a git remote URL. */
export function parseSlug(url) {
	const text = String(url ?? "").trim();
	if (text === "") return "";
	const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:[/#?]|$)/i.exec(text);
	if (match === null) return "";
	return `${match[1]}/${match[2]}`;
}

/**
 * Build the updater.
 *
 * @param {object} options - `{ logger, rootDir }`; `rootDir` is the plugin's own
 *   checkout (the parent of `lib/`).
 * @returns {{ snapshot: () => object, check: () => Promise<object>, apply: () => Promise<object> }}
 */
export function createUpdater(options) {
	const { logger, rootDir } = options;
	/** Last computed result; `status` serves this without touching the network. */
	let cache = {
		state: "unknown",
		current: { version: "", commit: "" },
		remote: null,
		behind: false,
		detail: "",
		checkedAt: 0
	};
	/** Full SHAs, kept out of the payload but needed for the comparison. */
	let localFull = "";
	let busy = false;

	/** Run one git command inside the checkout. Throws on non-zero exit. */
	async function git(args) {
		const result = await run("git", ["-C", rootDir, ...args], {
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 4 << 20,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" }
		});
		return String(result?.stdout ?? "").trim();
	}

	/** Own package.json, read fresh so a pull is reflected immediately. */
	function ownPackage() {
		try {
			return JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
		} catch {
			return {};
		}
	}

	/** Ask GitHub for the head commit + version of the default branch. */
	async function remoteViaApi(slug) {
		if (slug === "") throw new Error("package.json 里没有 GitHub 仓库地址");
		const headers = { accept: "application/vnd.github+json", "user-agent": "dsh-complugin" };
		const commitResponse = await fetch(`${API}/repos/${slug}/commits/main`, {
			headers,
			signal: AbortSignal.timeout(12_000)
		});
		if (commitResponse.ok === false) throw new Error(`GitHub 返回 ${commitResponse.status}`);
		const commit = await commitResponse.json();
		let version = "";
		try {
			const rawResponse = await fetch(`${RAW}/${slug}/main/package.json`, {
				headers: { "user-agent": "dsh-complugin" },
				signal: AbortSignal.timeout(12_000)
			});
			if (rawResponse.ok) version = String((await rawResponse.json()).version ?? "");
		} catch {
			// Version is cosmetic; the commit comparison is what decides.
		}
		return {
			sha: String(commit.sha ?? ""),
			at: String(commit.commit?.author?.date ?? ""),
			message: tail(String(commit.commit?.message ?? "").split("\n")[0], 120),
			version
		};
	}

	/** Compare the checkout with the remote and cache the verdict. */
	async function check() {
		if (busy) return cache;
		busy = true;
		const pkg = ownPackage();
		const version = String(pkg.version ?? "");
		const slug = parseSlug(pkg.repository?.url ?? pkg.repository ?? "");
		try {
			localFull = await git(["rev-parse", "HEAD"]);
			// An empty answer means git ran but told us nothing — never let that
			// pass as "up to date", which is how a broken runner hides itself.
			if (localFull === "") throw new Error("git 没有返回提交号");
			const short = await git(["rev-parse", "--short", "HEAD"]);
			cache.current = { version, commit: short };
		} catch (error) {
			localFull = "";
			cache = {
				state: "no-git",
				current: { version, commit: "" },
				remote: null,
				behind: false,
				detail: `本机跑不了 git（${tail(renderThrown(error), 120)}），只能手动更新`,
				checkedAt: Date.now()
			};
			busy = false;
			return cache;
		}

		let remote = null;
		let behind = false;
		let state = "current";
		let detail = "";
		try {
			// No `--depth`: a shallow fetch grafts the remote tip onto nothing and
			// makes every ancestry check report "diverged".
			await git(["fetch", "--quiet", "origin", "main"]);
			const originFull = await git(["rev-parse", "origin/main"]);
			remote = {
				sha: originFull.slice(0, 7),
				at: await git(["log", "-1", "--format=%cI", "origin/main"]),
				message: tail(await git(["log", "-1", "--format=%s", "origin/main"]), 120),
				version: await (async () => {
					try {
						return String(JSON.parse(await git(["show", "origin/main:package.json"])).version ?? "");
					} catch {
						return "";
					}
				})()
			};
			const isAncestor = async (a, b) => {
				try {
					await git(["merge-base", "--is-ancestor", a, b]);
					return true;
				} catch {
					return false;
				}
			};
			if (originFull === localFull) {
				state = "current";
				detail = "已是最新提交";
			} else if (await isAncestor(localFull, originFull)) {
				state = "behind";
				behind = true;
				detail = `仓库有新提交：${remote.message}`;
			} else if (await isAncestor(originFull, localFull)) {
				state = "ahead";
				detail = "本地比仓库新（有未推送的提交）";
			} else {
				state = "diverged";
				detail = "本地与仓库已分叉，需要手动处理";
			}
		} catch (error) {
			// No network or no remote: fall back to the API for a commit compare.
			try {
				remote = await remoteViaApi(slug);
				behind = remote.sha !== "" && !String(localFull).startsWith(remote.sha);
				state = behind ? "behind" : "current";
				detail = behind ? `仓库有新提交：${remote.message}` : "已是最新提交（git 拉不动，用 API 比对）";
			} catch (inner) {
				state = "error";
				detail = `检查失败：${tail(renderThrown(inner), 120)}`;
			}
		}

		cache = { state, current: cache.current, remote, behind, detail, checkedAt: Date.now(), root: rootDir };
		busy = false;
		return cache;
	}

	/** Fast-forward the checkout when it is strictly behind. */
	async function apply() {
		if (busy) return { ok: false, detail: "上一个更新动作还没结束" };
		const before = cache;
		if (before.state !== "behind" && before.behind !== true) {
			await check();
		}
		if (cache.state === "no-git") return { ok: false, detail: cache.detail };
		if (cache.state === "diverged") return { ok: false, detail: "本地与仓库已分叉，先手动处理再更新" };
		if (cache.state === "ahead") return { ok: true, detail: "本地已领先仓库，无需更新" };
		if (cache.behind !== true) return { ok: true, detail: "已是最新版本" };
		busy = true;
		try {
			const output = await git(["pull", "--ff-only", "--quiet"]);
			logger.info(`已从仓库更新：${tail(output, 120) || "fast-forward"}`);
			busy = false;
			const after = await check();
			return {
				ok: true,
				detail: `已更新到 ${after.current.commit || after.remote?.sha || "最新提交"}，重启 DSH 后生效`,
				needsRestart: true
			};
		} catch (error) {
			busy = false;
			const reason = renderThrown(error);
			logger.warn(`自动更新失败：${reason}`);
			return { ok: false, detail: `更新失败：${tail(reason, 160)}` };
		}
	}

	return {
		snapshot: () => ({ ...cache }),
		check,
		apply
	};
}
