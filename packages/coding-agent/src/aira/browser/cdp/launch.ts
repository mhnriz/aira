/**
 * Aira browser — Chromium discovery and launch.
 *
 * Aira LAUNCHES its own isolated browser; it never attaches to the user's
 * personal Chrome. The profile is an Aira-owned directory (canonical path
 * helpers); remote debugging binds a random loopback port and the websocket
 * URL is read from the profile's `DevToolsActivePort` file, which Chrome
 * itself writes (same mechanism devtools uses; proven, no fixed ports).
 *
 * Discovery order for the executable:
 *   1. AIRA_BROWSER_EXECUTABLE (explicit override, absolute path);
 *   2. platform candidates (macOS applications, Windows Program Files,
 *      Linux distributions);
 *   3. PATH shims (google-chrome, chromium, chromium-browser,
 *      microsoft-edge, chrome).
 *
 * A missing browser is a truthful `unavailable` state — Aira itself always
 * installs and runs without one.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { getShellEnv } from "../../../utils/shell.ts";
import type { AiraBrowserAvailability } from "../provider.ts";

export const CDP_PROVIDER_ID = "cdp-chromium";

/** Browser executable candidates per platform (checked in order). */
export function chromiumExecutableCandidates(platform: NodeJS.Platform = process.platform): readonly string[] {
	const candidates: string[] = [];
	if (process.env.AIRA_BROWSER_EXECUTABLE?.trim()) {
		candidates.push(process.env.AIRA_BROWSER_EXECUTABLE.trim());
	}
	if (platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		);
	} else if (platform === "win32") {
		const base = process.env.LOCALAPPDATA ?? "C:\\Program Files";
		const base2 = process.env.PROGRAMFILES ?? "C:\\Program Files";
		candidates.push(
			join(base, "Google", "Chrome", "Application", "chrome.exe"),
			join(base2, "Google", "Chrome", "Application", "chrome.exe"),
			join(base2, "Microsoft", "Edge", "Application", "msedge.exe"),
			join(base2, "(x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
		);
	} else {
		candidates.push(
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge",
		);
	}
	return candidates;
}

/** Resolution result: picked executable path + human detail. */
export interface AiraBrowserExecutable {
	path: string;
	detail: string;
}

/** Resolve a usable browser executable, or a truthful reason. */
export function resolveChromiumExecutable(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { ok: true; executable: AiraBrowserExecutable } | { ok: false; reason: string } {
	for (const candidate of chromiumExecutableCandidates(platform)) {
		if (!candidate) {
			continue;
		}
		if (isExecutableFile(candidate)) {
			const detail = env.AIRA_BROWSER_EXECUTABLE ? `${candidate} (AIRA_BROWSER_EXECUTABLE)` : candidate;
			return { ok: true, executable: { path: candidate, detail } };
		}
	}
	// PATH shims.
	const shims = ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "chrome"];
	const pathDirs = (env.PATH ?? "").split(platform === "win32" ? ";" : ":");
	for (const dir of pathDirs) {
		for (const shim of shims) {
			const candidate = join(dir, platform === "win32" ? `${shim}.exe` : shim);
			if (isExecutableFile(candidate)) {
				return { ok: true, executable: { path: candidate, detail: `${candidate} (PATH)` } };
			}
		}
	}
	const tried = chromiumExecutableCandidates(platform).filter(Boolean).join(", ");
	return {
		ok: false,
		reason: `no supported browser executable found (tried: ${tried}; set AIRA_BROWSER_EXECUTABLE to point at Chrome/Chromium)`,
	};
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export interface AiraBrowserLaunchHandle {
	pid: number | undefined;
	/** ws://127.0.0.1:<port><path> CDP browser endpoint. */
	wsUrl: string;
	/** Kill the browser (graceful then forced). Own process only. */
	kill(graceMs?: number): Promise<void>;
	/** True while the browser process is (believed) alive. */
	alive(): boolean;
}

const LAUNCH_READY_TIMEOUT_MS = 20_000;
const DEVPORTS_POLL_MS = 100;

function isSandboxForced(): boolean {
	// Chromium refuses to start without a sandbox when run as root; containers
	// often have no user namespaces either. Only then do we relax it.
	try {
		return (process.getuid?.() ?? 1) === 0;
	} catch {
		return false;
	}
}

function chromiumBaseArgs(profileDir: string, platform: NodeJS.Platform): string[] {
	const args = [
		`--user-data-dir=${profileDir}`,
		"--remote-debugging-port=0",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--metrics-recording-only",
		"--disable-default-apps",
		"--disable-extensions",
		"--disable-features=Translate,OptimizationHints",
		"--window-size=1280,800",
	];
	if (platform === "linux") {
		args.push("--disable-dev-shm-usage");
		if (isSandboxForced()) {
			args.push("--no-sandbox");
		}
	}
	return args;
}

/**
 * Launch an isolated browser and wait until its CDP endpoint is live.
 *
 * The browser process is spawned detached and tracked by the caller; kill()
 * only ever terminates this Aira-owned process.
 */
export async function launchIsolatedBrowser(options: {
	executable: string;
	profileDir: string;
	headed?: boolean;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}): Promise<{ handle: AiraBrowserLaunchHandle; child: ChildProcess } | { error: string }> {
	const platform = options.platform ?? process.platform;
	const env = { ...(options.env ?? getShellEnv()) };
	const args = [
		...chromiumBaseArgs(options.profileDir, platform),
		...(options.headed ? [] : ["--headless=new"]),
		"about:blank",
	];
	let child: ChildProcess;
	try {
		child = spawn(options.executable, args, {
			detached: platform !== "win32",
			env,
			stdio: "ignore",
			windowsHide: true,
		});
	} catch (err) {
		return { error: `failed to launch ${options.executable}: ${err instanceof Error ? err.message : String(err)}` };
	}
	// Spawn failures surface asynchronously as 'error' events on the child.
	const spawnFailure = await new Promise<string | null>((resolve) => {
		child.once("spawn", () => resolve(null));
		child.once("error", (err: Error) => resolve(err.message));
	});
	if (spawnFailure !== null) {
		return { error: `failed to launch ${options.executable}: ${spawnFailure}` };
	}
	child.on("error", () => {
		// Ignore post-spawn errors; the exit / close events drive lifecycle.
	});

	const devPorts = join(options.profileDir, "DevToolsActivePort");
	const deadline = (options.now?.() ?? Date.now()) + LAUNCH_READY_TIMEOUT_MS;
	while ((options.now?.() ?? Date.now()) < deadline) {
		try {
			const content = readFileSync(devPorts, "utf8").trim().split("\n");
			const port = Number(content[0]?.trim());
			const path = content[1]?.trim();
			if (Number.isInteger(port) && port > 0 && path) {
				const wsUrl = `ws://127.0.0.1:${port}${path}`;
				const handle: AiraBrowserLaunchHandle = {
					pid: child.pid,
					wsUrl,
					alive: () => child.exitCode === null && !child.killed,
					kill: async (graceMs = 1500) => {
						await terminateBrowserProcess(child, platform, graceMs);
					},
				};
				// A post-launch failure to stay up (bad profile, missing libs)
				// arrives as 'exit' shortly after spawn; surface it truthfully.
				const exitPromise = new Promise<string | null>((resolve) => {
					child.once("exit", (code, signal) => {
						resolve(`browser exited immediately (code ${code ?? "?"}, signal ${signal ?? "none"})`);
					});
				});
				const exited = await Promise.race([exitPromise, sleep(250).then(() => null)]);
				if (exited !== null) {
					return { error: exited };
				}
				return { handle, child };
			}
		} catch {
			// DevToolsActivePort not written yet.
		}
		await sleep(DEVPORTS_POLL_MS);
	}
	await terminateBrowserProcess(child, platform, 0);
	return { error: `browser did not open a CDP endpoint within ${LAUNCH_READY_TIMEOUT_MS}ms` };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Terminate the Aira-owned browser process: graceful, then forced. */
export async function terminateBrowserProcess(
	child: ChildProcess,
	platform: NodeJS.Platform,
	graceMs: number,
): Promise<void> {
	if (child.exitCode !== null || child.killed) {
		return;
	}
	if (platform === "win32") {
		// Graceful: taskkill without /F; the browser shuts its own tree down.
		try {
			spawn("taskkill", ["/PID", String(child.pid), "/T"], { stdio: "ignore", windowsHide: true });
		} catch {
			// fall back to direct kill below
		}
		await waitForExit(child, graceMs);
		if (child.exitCode === null) {
			try {
				spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					// nothing left to do
				}
			}
			await waitForExit(child, 1000);
		}
		return;
	}
	try {
		child.kill("SIGTERM");
	} catch {
		// already gone
	}
	await waitForExit(child, graceMs);
	if (child.exitCode === null) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
		await waitForExit(child, 1000);
	}
}

function waitForExit(child: ChildProcess, ms: number): Promise<void> {
	if (child.exitCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(), ms);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** Availability probe (cheap; no launch). */
export function chromiumAvailability(): AiraBrowserAvailability {
	const resolved = resolveChromiumExecutable();
	if (!resolved.ok) {
		return {
			available: false,
			provider: CDP_PROVIDER_ID,
			reason: resolved.reason,
		};
	}
	return {
		available: true,
		provider: CDP_PROVIDER_ID,
		detail: resolved.executable.detail,
	};
}
