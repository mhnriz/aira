/**
 * Phase 7 — host integration through the real AgentSession path.
 *
 * - every session arms its own browser runtime and gets the browser tools,
 *   active by default;
 * - a real model tool call opens the browser and observes the page through
 *   the native tool surface (fake provider — browser mechanics are not the
 *   subject here);
 * - PLAN hides the interact/lifecycle tools AND blocks them at the boundary,
 *   while observation/navigation stay available;
 * - ambient context honors off/auto/on through the actual prompt path
 *   (zero-token and relevant cases, dedupe);
 * - browser absence degrades truthfully (availability/status, never breaks
 *   the session).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AiraBrowserProvider } from "../../../src/aira/browser/provider.ts";
import type { AiraBrowserEvidenceDrain } from "../../../src/aira/browser/types.ts";
import { createHarness, type Harness } from "../../suite/harness.ts";

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-suite-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "browser-proj", scripts: { dev: "node server.js" } }),
	);
	return root;
}

/** The harness injects this fake provider through airaBrowserOptions. */
function fakeProviderFactory(): AiraBrowserProvider {
	const tab = { id: "tab-1", url: "http://localhost:5173/", title: "fixture", readyState: "complete" as const };
	let open = false;
	const exits = new Set<(reason: string) => void>();
	return {
		id: "fake",
		async probeAvailability() {
			return { available: true, provider: "fake", detail: "fake provider" };
		},
		async open(options) {
			open = true;
			if (options.url) tab.url = options.url;
			return { ok: true, operation: "open", tab: { ...tab } };
		},
		async close() {
			open = false;
			return { ok: true, operation: "close" };
		},
		tabs() {
			return open ? [{ ...tab }] : [];
		},
		activeTabId() {
			return open ? tab.id : undefined;
		},
		async activateTab() {
			return { ok: true, operation: "activate-tab" };
		},
		async closeTab() {
			return { ok: true, operation: "close-tab" };
		},
		async observe() {
			return {
				title: "fixture",
				url: tab.url,
				readyState: "complete",
				summary: "fixture page · ready · 2 buttons",
				nodeCount: 14,
				outline: '- button "Go" [e1]\n- button "Stop" [e2]',
				truncated: false,
				targets: [
					{ ref: "e1", role: "button", name: "Go", x: 10, y: 10 },
					{ ref: "e2", role: "button", name: "Stop", x: 50, y: 10 },
				],
				at: Date.now(),
			};
		},
		async navigate(_tabId, options) {
			tab.url = options.url;
			return { ok: true, operation: "navigate", target: options.url, tab: { ...tab } };
		},
		async resolveTarget() {
			return { x: 10, y: 10, label: "e1" };
		},
		async click(_tabId, options) {
			return { ok: true, operation: "click", target: options.ref, tab: { ...tab } };
		},
		async fill() {
			return { ok: true, operation: "fill" };
		},
		async pressKey() {
			return { ok: true, operation: "press" };
		},
		async scroll() {
			return { ok: true, operation: "scroll" };
		},
		async wait() {
			return { ok: true, operation: "wait" };
		},
		async evaluate() {
			return { ok: true, operation: "evaluate", summary: "ok" };
		},
		async consoleEvidence(): Promise<AiraBrowserEvidenceDrain> {
			return { total: 0, overflowed: false, records: [], errors: 0, warnings: 0 };
		},
		async networkEvidence(): Promise<AiraBrowserEvidenceDrain> {
			return { total: 0, overflowed: false, records: [], failures: 0 };
		},
		async screenshot(_tabId, dir, kind) {
			return `${dir}/${kind}-fake.jpg`;
		},
		async dispose() {
			open = false;
		},
		onBrowserExit(listener) {
			exits.add(listener);
			return () => exits.delete(listener);
		},
	};
}

function messageTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((m) => m.role === "assistant" || m.role === "toolResult")
		.map((m) => {
			const content: unknown = m.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter((p) => (p as { type?: string }).type === "text")
					.map((p) => (p as { text?: string }).text ?? "")
					.join("\n");
			}
			return "";
		})
		.filter((t) => t.length > 0);
}

/** Custom (display:false) message contents by customType. */
function customMessages(harness: Harness): Array<{ customType?: string; content?: unknown }> {
	return harness.session.messages.filter((m) => m.role === "custom") as Array<{
		customType?: string;
		content?: unknown;
	}>;
}

describe("Aira browser runtime through the host (Phase 7)", () => {
	it("arms the per-session browser runtime and registers the browser tools by default", async () => {
		const harness = await createHarness({
			cwd: makeProjectDir(),
			airaBrowserOptions: { provider: fakeProviderFactory() },
		});
		try {
			expect(harness.session.airaBrowser).toBeDefined();
			const names = harness.session.getActiveToolNames();
			for (const tool of [
				"browser_open",
				"browser_status",
				"browser_observe",
				"browser_navigate",
				"browser_click",
				"browser_fill",
				"browser_press",
				"browser_scroll",
				"browser_wait",
				"browser_evaluate",
				"browser_console",
				"browser_network",
				"browser_screenshot",
				"browser_verify",
				"browser_close",
			]) {
				expect(names).toContain(tool);
			}
			// Canonical state carries the browser snapshot.
			expect(harness.session.airaSessionState.browser).toBeDefined();
			expect(harness.session.airaSessionState.browser!.status).toBe("idle");
		} finally {
			harness.session.dispose();
		}
	});

	it("runs a real model tool call: open → observe returns structured page state", async () => {
		// Phase 11: browser lifecycle is an ASK by default in normal permission
		// mode; this flow tests the mechanics, so the session opts into
		// permissive (auto-approve) mode explicitly.
		const harness = await createHarness({
			cwd: makeProjectDir(),
			settings: { permissions: { enabled: true, mode: "permissive" } } as never,
			airaBrowserOptions: { provider: fakeProviderFactory() },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([
					fauxToolCall("browser_open", { url: "http://localhost:5173" }),
					fauxToolCall("browser_observe", {}),
				]),
				fauxAssistantMessage(fauxText("final")),
			]);
			await harness.session.prompt("open the app and look at the page");
			const texts = messageTexts(harness);
			const joined = texts.join("\n");
			expect(joined).toContain("fixture page");
			expect(joined).toContain("[e1]");
			// The canonical snapshot carries the observation summary.
			expect(harness.session.airaSessionState.browser!.observation.summary).toContain("fixture");
			expect(harness.session.airaSessionState.browser!.status).toBe("active");
		} finally {
			harness.session.dispose();
		}
	});

	it("PLAN blocks browser interaction at the boundary and keeps observation available", async () => {
		const harness = await createHarness({
			cwd: makeProjectDir(),
			airaBrowserOptions: { provider: fakeProviderFactory() },
		});
		try {
			harness.session.setAiraMode("plan");
			// Interact/lifecycle tools hidden from the model.
			const names = harness.session.getActiveToolNames();
			expect(names).toContain("browser_observe");
			expect(names).toContain("browser_navigate");
			expect(names).not.toContain("browser_click");
			expect(names).not.toContain("browser_open");
			// Boundary blocks them anyway.
			for (const tool of ["browser_open", "browser_click", "browser_fill", "browser_evaluate", "browser_verify"]) {
				const result = await harness.session.agent.beforeToolCall?.({
					toolCall: { name: tool, id: "t", args: {} },
					args: {},
				} as never);
				expect(result?.block, tool).toBe(true);
			}
			// Observation passes the boundary.
			const observe = await harness.session.agent.beforeToolCall?.({
				toolCall: { name: "browser_observe", id: "t", args: {} },
				args: {},
			} as never);
			expect(observe?.block).toBeUndefined();
		} finally {
			harness.session.dispose();
		}
	});

	it("ambient context respects browser.context=off through the prompt path", async () => {
		const harness = await createHarness({
			cwd: makeProjectDir(),
			settings: { browser: { context: "off" } },
			airaBrowserOptions: { provider: fakeProviderFactory() },
		});
		try {
			// Prime an active browser with fresh state.
			const browser = harness.session.airaBrowser!;
			await browser.activate();
			await browser.open();
			await browser.observe({});
			harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
			await harness.session.prompt("check the page");
			const browserMessages = customMessages(harness).filter((m) => m.customType === "aira.browser");
			expect(browserMessages.length).toBe(0);
			// The snapshot still shows the state (UI-visible, token-free).
			expect(harness.session.airaSessionState.browser!.status).toBe("active");
		} finally {
			harness.session.dispose();
		}
	});

	it("ambient context auto mode injects zero tokens for unrelated prompts and injects on signal", async () => {
		const harness = await createHarness({
			cwd: makeProjectDir(),
			airaBrowserOptions: { provider: fakeProviderFactory() },
		});
		try {
			const browser = harness.session.airaBrowser!;
			// Browser idle: unrelated prompt → no browser context.
			harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
			await harness.session.prompt("explain the README");
			expect(customMessages(harness).filter((m) => m.customType === "aira.browser").length).toBe(0);

			// Open + observe (fresh state enters once), then navigate (signal).
			await browser.activate();
			await browser.open();
			await browser.observe({});
			harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
			await harness.session.prompt("what did we just see?");
			const injected = customMessages(harness).filter((m) => m.customType === "aira.browser");
			expect(injected.length).toBeGreaterThanOrEqual(1);
			const content = String(injected[0]!.content ?? "");
			expect(content).toContain("Browser");
			// Steady state: the next unrelated prompt injects nothing new.
			const before = customMessages(harness).length;
			harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
			await harness.session.prompt("update the README");
			expect(customMessages(harness).length).toBe(before);
		} finally {
			harness.session.dispose();
		}
	});

	it("degrades truthfully when no provider is available", async () => {
		const harness = await createHarness({
			cwd: makeProjectDir(),
			airaBrowserOptions: {
				provider: {
					id: "fake",
					async probeAvailability() {
						return { available: false, provider: "fake", reason: "no browser executable" };
					},
					async open() {
						return { ok: false, operation: "open", reason: "browser unavailable: no browser executable" };
					},
					async close() {
						return { ok: true, operation: "close" };
					},
					tabs: () => [],
					activeTabId: () => undefined,
					async activateTab() {
						return { ok: true, operation: "activate-tab" };
					},
					async closeTab() {
						return { ok: true, operation: "close-tab" };
					},
					async observe() {
						throw new Error("not open");
					},
					async navigate() {
						return { ok: false, operation: "navigate", reason: "not open" };
					},
					async resolveTarget() {
						throw new Error("not open");
					},
					async click() {
						return { ok: false, operation: "click", reason: "not open" };
					},
					async fill() {
						return { ok: false, operation: "fill", reason: "not open" };
					},
					async pressKey() {
						return { ok: false, operation: "press", reason: "not open" };
					},
					async scroll() {
						return { ok: false, operation: "scroll", reason: "not open" };
					},
					async wait() {
						return { ok: false, operation: "wait", reason: "not open" };
					},
					async evaluate() {
						return { ok: false, operation: "evaluate", reason: "not open" };
					},
					async consoleEvidence() {
						return { total: 0, overflowed: false, records: [] };
					},
					async networkEvidence() {
						return { total: 0, overflowed: false, records: [] };
					},
					async screenshot() {
						throw new Error("not open");
					},
					async dispose() {},
					onBrowserExit() {
						return () => {};
					},
				},
			},
		});
		try {
			await harness.session.airaBrowser!.activate();
			const status = harness.session.airaSessionState.browser!;
			expect(status.availability).toBe("unavailable");
			expect(status.status).toBe("unavailable");
			expect(status.reason).toContain("no browser executable");
			// The session still works normally.
			harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
			await harness.session.prompt("hello");
			expect(messageTexts(harness).join("\n")).toContain("ok");
		} finally {
			harness.session.dispose();
		}
	});
});
