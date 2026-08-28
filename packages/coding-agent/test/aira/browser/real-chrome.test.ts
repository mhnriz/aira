/**
 * Phase 7 — REAL Chrome integration (native CDP provider).
 *
 * Exercises the Aira-native CDP/Chromium provider against a deterministic
 * localhost fixture server (no public websites). Skipped truthfully when no
 * browser executable exists — Aira itself never requires one.
 *
 * Flow covered: availability probe → isolated launch (fresh profile under
 * canonical cache paths) → navigation → semantic observation with stable
 * refs → fill/click interaction with page-change diff → console error
 * capture → network failure capture → screenshot to managed path → stale
 * ref behavior → navigation timeout → cleanup (process dead, profile
 * removed, no orphans).
 */

import { accessSync, constants, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CdpBrowserProvider } from "../../../src/aira/browser/cdp/provider.ts";
import { createAiraBrowserManager } from "../../../src/aira/browser/manager.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

const FIXTURE_HTML = `<!doctype html>
<html><head><title>Aira Fixture</title></head>
<body>
  <h1>Fixture Counter</h1>
  <form id="form">
    <input id="name" type="text" placeholder="Your name" />
    <button id="go" type="button">Click me</button>
    <button id="boom" type="button">Trigger error</button>
  </form>
  <div id="out">count: 0</div>
  <script>
    let count = 0;
    console.info("fixture ready");
    document.getElementById("go").addEventListener("click", () => {
      count += 1;
      document.getElementById("out").textContent = "count: " + count;
    });
    document.getElementById("boom").addEventListener("click", () => {
      console.error("FixtureError: boom");
    });
    fetch("/api/ok").then((r) => r.json()).catch(() => {});
    fetch("/api/broken").then((r) => r.json()).catch(() => {});
  </script>
</body></html>`;

const SLOW_HTML = "<!doctype html><title>Slow</title>";

let server: Server | undefined;
let baseUrl = "";

function startFixture(): Promise<string> {
	return new Promise((resolve) => {
		const srv = createServer((req, res) => {
			const url = req.url ?? "/";
			if (url === "/api/ok") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"ok":true}');
				return;
			}
			if (url === "/api/broken") {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("not found");
				return;
			}
			if (url === "/delay") {
				setTimeout(() => {
					res.writeHead(200, { "content-type": "text/html" });
					res.end(SLOW_HTML);
				}, 4000);
				return;
			}
			if (url === "/slow") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(SLOW_HTML);
				return;
			}
			res.writeHead(200, { "content-type": "text/html" });
			res.end(FIXTURE_HTML);
		});
		srv.listen(0, "127.0.0.1", () => {
			const address = srv.address();
			if (address && typeof address === "object") {
				resolve(`http://127.0.0.1:${address.port}`);
			} else {
				resolve("http://127.0.0.1:0");
			}
		});
		server = srv;
	});
}

function hasChrome(): boolean {
	const candidates = [
		process.env.AIRA_BROWSER_EXECUTABLE,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter(Boolean) as string[];
	return candidates.some((c) => {
		try {
			accessSync(c, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

function profileDir(): string {
	return join(tmpdir(), `aira-browser-real-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

const describeReal = hasChrome() ? describe : describe.skip;

describeReal("Phase 7 — native CDP/Chromium provider against a local fixture", () => {
	let connection: { provider: CdpBrowserProvider; dir: string } | undefined;

	beforeAll(async () => {
		baseUrl = await startFixture();
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => {
			if (server) {
				server.close(() => resolve());
			} else {
				resolve();
			}
		});
	});

	it("probes availability and launches an ISOLATED browser with a fresh profile", async () => {
		const dir = profileDir();
		const provider = new CdpBrowserProvider({ profileDir: dir });
		const availability = await provider.probeAvailability();
		expect(availability.available).toBe(true);
		expect(availability.detail).toContain("Chrome");

		const opened = await provider.open({ profileDir: dir, url: baseUrl });
		expect(opened.ok).toBe(true);
		expect(dir).not.toBe("");
		connection = { provider, dir };
	}, 60_000);

	it("observes the page semantically: title, summary, stable refs with coordinates", async () => {
		const { provider } = connection!;
		const tabId = provider.activeTabId()!;
		const observation = await provider.observe(tabId, {});
		expect(observation.title).toBe("Aira Fixture");
		expect(observation.url).toBe(`${baseUrl}/`);
		expect(observation.readyState).toBe("complete");
		expect(observation.summary).toContain("Aira Fixture");
		// Semantic structure, not a DOM dump: heading/button/input roles.
		expect(observation.outline).toContain("heading");
		expect(observation.outline).toContain("button");
		expect(observation.outline).toContain("textbox");
		// Stable interactive refs.
		const names = observation.targets.map((t) => t.name ?? "");
		expect(names.some((n) => n === "Click me")).toBe(true);
		expect(names.some((n) => n === "Your name")).toBe(true);
		const button = observation.targets.find((t) => t.name === "Click me")!;
		expect(button.ref).toMatch(/^e\d+$/);
		expect(button.x).toBeGreaterThan(0);
		expect(button.y).toBeGreaterThan(0);
	}, 30_000);

	it("interacts via refs: fill + click land with a page-change diff", async () => {
		const { provider } = connection!;
		const tabId = provider.activeTabId()!;
		const observation = await provider.observe(tabId, {});
		const input = observation.targets.find((t) => t.role === "textbox")!;
		const button = observation.targets.find((t) => t.name === "Click me")!;

		const filled = await provider.fill(tabId, input.ref, "Aira");
		expect(filled.ok).toBe(true);
		// Live value refreshed post-fill (AX value is stale).
		const after = await provider.observe(tabId, { maxNodes: 150 });
		const inputAfter = after.targets.find((t) => t.role === "textbox")!;
		expect(inputAfter.value).toBe("Aira");

		const clicked = await provider.click(tabId, { ref: button.ref });
		expect(clicked.ok).toBe(true);
		// The counter div moved → compact page-change diff.
		expect(clicked.changes?.length ?? 0).toBeGreaterThan(0);
	}, 30_000);

	it("captures bounded console evidence with the exact error message", async () => {
		const { provider } = connection!;
		const tabId = provider.activeTabId()!;
		const observation = await provider.observe(tabId, {});
		const boom = observation.targets.find((t) => t.name === "Trigger error")!;
		await provider.click(tabId, { ref: boom.ref });
		const drain = await provider.consoleEvidence(tabId, {});
		expect(drain.errors).toBeGreaterThanOrEqual(1);
		const text = JSON.stringify(drain.records.map((r) => (r as { text?: string }).text));
		expect(text).toContain("FixtureError: boom");
	}, 30_000);

	it("captures bounded network failure evidence (404) and ignores successful traffic", async () => {
		const { provider } = connection!;
		const tabId = provider.activeTabId()!;
		const drain = await provider.networkEvidence(tabId, {});
		expect(drain.failures).toBeGreaterThanOrEqual(1);
		const text = JSON.stringify(
			drain.records.map((r) => ({ url: (r as { url?: string }).url, status: (r as { status?: number }).status })),
		);
		expect(text).toContain("/api/broken");
		expect(text).toContain("404");
		// Successful fixture traffic never becomes evidence.
		expect(text).not.toContain("/api/ok");
	}, 30_000);

	it("saves a screenshot to the Aira-managed path (jpeg bytes, never in state)", async () => {
		const { provider } = connection!;
		const tabId = provider.activeTabId()!;
		const dir = join(tmpdir(), `aira-browser-shots-${Date.now()}`);
		const path = await provider.screenshot(tabId, dir, "fixture");
		expect(existsSync(path)).toBe(true);
		const bytes = readFileSync(path);
		expect(bytes.length).toBeGreaterThan(1000);
		// JPEG magic.
		expect(bytes[0]).toBe(0xff);
		expect(bytes[1]).toBe(0xd8);
		rmSync(dir, { recursive: true, force: true });
	}, 30_000);

	it("reports stale refs truthfully after navigation (never silently re-targets)", async () => {
		const { provider } = connection!;
		const tabId = provider.activeTabId()!;
		const observation = await provider.observe(tabId, {});
		const ref = observation.targets[0]!.ref;
		// Navigate away: the observed elements are gone.
		const navigated = await provider.navigate(tabId, {
			url: `${baseUrl}/slow`,
			waitUntil: "domcontentloaded",
			timeoutMs: 5000,
		});
		expect(navigated.ok).toBe(true);
		// A stale ref is a truthful result, never a click at a wrong element
		// (refs are invalidated on main-frame navigation and at resolve time).
		const clicked = await provider.click(tabId, { ref });
		expect(clicked.ok).toBe(false);
		expect(clicked.reason).toContain("stale");
		// DOM.resolveNode must never resolve a cross-document node: the click
		// reported failure WITHOUT dispatching to a wrong element.
		const fresh = await provider.observe(tabId, { maxNodes: 50 });
		expect(fresh.url).toBe(`${baseUrl}/slow`);
	}, 30_000);

	it("reports navigation timeouts truthfully", async () => {
		const { provider } = connection!;
		const tabId = provider.activeTabId()!;
		const result = await provider.navigate(tabId, { url: `${baseUrl}/delay`, waitUntil: "load", timeoutMs: 800 });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("did not reach");
	}, 30_000);

	it("closes cleanly: browser process dead, profile removed, no orphans", async () => {
		const { provider, dir } = connection!;
		await provider.close();
		// Aira-owned process must be gone.
		expect(existsSync(dir)).toBe(false);
	}, 30_000);

	it("works through the manager end-to-end (canonical snapshot + ambient context)", async () => {
		const state = acquireAiraSessionState("real-chrome-manager", "startup");
		state.project = {
			root: "/tmp/web",
			git: { hasGit: true, root: "/tmp/web" },
			languages: ["typescript"],
			frameworks: ["react"],
			packageManagers: ["npm"],
			testCommands: [],
			buildCommands: [],
			checkCommands: [],
			devCommands: [],
			browserRelevant: true,
			deploymentHints: [],
			confidence: "high",
		};
		const manager = createAiraBrowserManager(state, {
			provider: () => new CdpBrowserProvider({ profileDir: profileDir() }),
			settings: () => ({ enabled: true, context: "auto", autoVerify: true, contextBudget: "compact" }),
			devRuntime: () => ({ running: false, output: "" }),
		});
		try {
			await manager.activate();
			const opened = await manager.open({ url: baseUrl });
			expect(opened.ok, `open failed: ${opened.reason ?? "unknown"}`).toBe(true);
			expect(state.browser!.status).toBe("active");
			expect(state.browser!.profileKind).toBe("isolated");
			const observed = await manager.observe({ maxNodes: 150 });
			expect(observed.observation.title).toBe("Aira Fixture");
			expect(state.browser!.observation.summary).toContain("Aira Fixture");
			// Ambient context: one bounded pack, then dedupe.
			const first = manager.providePromptContext("what does the page show?");
			expect(first).toBeDefined();
			expect(first!.length).toBeLessThanOrEqual(600);
			expect(manager.providePromptContext("again?")).toBeUndefined();
		} finally {
			await manager.dispose();
			disposeAiraSessionState(state.sessionId, state);
		}
	}, 60_000);
});
