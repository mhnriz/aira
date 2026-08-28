/**
 * Phase 7 — browser manager tests through the provider boundary.
 *
 * A scripted FAKE provider drives the manager, so lifecycle, ownership,
 * snapshot publishing, ambient context, auto-verify flow, and cleanup are
 * tested without a browser. Real-browser verification lives in
 * real-chrome.test.ts.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	type AiraBrowserHandle,
	AiraBrowserNotOpenError,
	createAiraBrowserManager,
} from "../../../src/aira/browser/manager.ts";
import type {
	AiraBrowserAvailability,
	AiraBrowserClickOptions,
	AiraBrowserNavigateOptions,
	AiraBrowserObserveOptions,
	AiraBrowserProvider,
} from "../../../src/aira/browser/provider.ts";
import type { AiraBrowserSettings } from "../../../src/aira/browser/settings.ts";
import type {
	AiraBrowserEvidenceDrain,
	AiraBrowserObservation,
	AiraBrowserOperationResult,
	AiraBrowserWaitCondition,
} from "../../../src/aira/browser/types.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

/** A scripted in-memory provider implementing the boundary. */
type FakeProvider = AiraBrowserProvider & {
	simulateCrash(): void;
	openCount: { value: number };
	verifyNavigations: string[];
};

function createFakeProvider(script: {
	availability?: AiraBrowserAvailability;
	open?: (url?: string) => AiraBrowserOperationResult;
	disposeCalls?: () => void;
	observation?: AiraBrowserObservation;
	openCount?: { value: number };
	verifyNavigations?: string[];
}): FakeProvider {
	const openCount = script.openCount ?? { value: 0 };
	const verifyNavigations = script.verifyNavigations ?? [];
	let exits: Array<(reason: string) => void> = [];
	let open = false;
	const tab = { id: "tab-1", url: "http://localhost:5173/", title: "fixture", readyState: "complete" as const };
	const provider = {
		id: "fake",
		async probeAvailability() {
			return script.availability ?? { available: true, provider: "fake", detail: "fake provider" };
		},
		async open(options: { url?: string }) {
			openCount.value += 1;
			open = true;
			if (options.url) {
				if (script.verifyNavigations) script.verifyNavigations.push(options.url);
			}
			tab.url = options.url ?? tab.url;
			if (script.open) {
				return script.open(options.url);
			}
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
		async observe(_tabId: string, _options?: AiraBrowserObserveOptions) {
			if (!open) throw new Error("not open");
			return (
				script.observation ?? {
					title: "fixture",
					url: tab.url,
					readyState: "complete",
					summary: "fixture page · ready · 1 button",
					nodeCount: 12,
					outline: '- button "Go" [e1]',
					truncated: false,
					targets: [{ ref: "e1", role: "button", name: "Go", x: 100, y: 100 }],
					at: Date.now(),
				}
			);
		},
		async navigate(_tabId: string, options: AiraBrowserNavigateOptions) {
			verifyNavigations.push(options.url);
			tab.url = options.url;
			return { ok: true, operation: "navigate", target: options.url, tab: { ...tab } };
		},
		async resolveTarget(_tabId: string, ref: string) {
			return { x: 100, y: 100, label: ref };
		},
		async click(_tabId: string, options: AiraBrowserClickOptions) {
			return { ok: true, operation: "click", target: options.ref, tab: { ...tab } };
		},
		async fill(_tabId: string, ref: string, _value: string | boolean) {
			return { ok: true, operation: "fill", target: ref, tab: { ...tab } };
		},
		async pressKey(_tabId: string) {
			return { ok: true, operation: "press" };
		},
		async scroll(_tabId: string) {
			return { ok: true, operation: "scroll" };
		},
		async wait(_tabId: string, _condition: AiraBrowserWaitCondition) {
			return { ok: true, operation: "wait" };
		},
		async evaluate(_tabId: string) {
			return { ok: true, operation: "evaluate", summary: "42" };
		},
		async consoleEvidence(): Promise<AiraBrowserEvidenceDrain> {
			return { total: 1, overflowed: false, records: [], errors: 0, warnings: 0 };
		},
		async networkEvidence(): Promise<AiraBrowserEvidenceDrain> {
			return { total: 0, overflowed: false, records: [], failures: 0 };
		},
		async screenshot(_tabId: string, dir: string, kind: string) {
			return `${dir}/${kind}-fake.jpg`;
		},
		async dispose() {
			open = false;
			script.disposeCalls?.();
		},
		onBrowserExit(listener: (reason: string) => void) {
			exits.push(listener);
			return () => {
				exits = exits.filter((l) => l !== listener);
			};
		},
		simulateCrash() {
			for (const listener of exits) listener("browser process exited (code 5)");
		},
	} as const;
	const exposed = provider as unknown as FakeProvider;
	exposed.openCount = openCount;
	exposed.verifyNavigations = verifyNavigations;
	return exposed;
}

interface StateFixture {
	state: ReturnType<typeof acquireAiraSessionState>;
	manager: AiraBrowserHandle;
	provider: FakeProvider;
}

function makeManager(
	options: {
		settings?: AiraBrowserSettings;
		dev?: { running: boolean; output?: string; processId?: string };
		project?: Record<string, unknown>;
		now?: () => number;
		providerScript?: Parameters<typeof createFakeProvider>[0];
	} = {},
): StateFixture {
	const state = acquireAiraSessionState("browser-manager-test", "startup");
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
		...(options.project as object),
	};
	const provider = createFakeProvider(options.providerScript ?? {});
	const manager = createAiraBrowserManager(state, {
		provider: provider as AiraBrowserProvider,
		settings: () =>
			options.settings ?? { enabled: true, context: "auto", autoVerify: true, contextBudget: "compact" },
		devRuntime: () => ({
			running: options.dev?.running ?? false,
			output: options.dev?.output ?? "",
			processId: options.dev?.processId,
			processStatus: "running",
		}),
		now: options.now ?? (() => Date.now()),
	});
	return { state, manager, provider };
}

function editEvent(toolName: string, path: string, _isError = false): AgentEvent {
	return {
		type: "tool_execution_start",
		toolName,
		args: { path },
		toolCallId: "t1",
	} as unknown as AgentEvent;
}

function editEndEvent(toolCallId: string, isError = false): AgentEvent {
	return { type: "tool_execution_end", toolName: "edit", args: {}, toolCallId, isError } as unknown as AgentEvent;
}

describe("Phase 7 — browser manager (fake provider)", () => {
	it("starts idle and publishes a bounded canonical snapshot, no browser launched", async () => {
		const { state, manager, provider } = makeManager();
		await manager.activate();
		const status = state.browser!;
		expect(status.status).toBe("idle");
		expect(status.availability).toBe("available");
		expect(status.profileKind).toBe("isolated");
		expect(status.tabs).toEqual([]);
		expect(status.console).toEqual({ errors: 0, warnings: 0, total: 0 });
		expect(provider.openCount.value).toBe(0);
		disposeAiraSessionState(state.sessionId, state);
	});

	it("reports unavailable truthfully when no browser exists", async () => {
		const { state, manager } = makeManager({
			providerScript: { availability: { available: false, provider: "fake", reason: "no browser executable" } },
		});
		await manager.activate();
		expect(state.browser!.availability).toBe("unavailable");
		expect(state.browser!.status).toBe("unavailable");
		const opened = await manager.open();
		expect(opened.ok).toBe(false);
		expect(opened.reason).toContain("no browser executable");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("open → active snapshot with tab; observe publishes observation revision", async () => {
		const { state, manager } = makeManager();
		await manager.activate();
		const opened = await manager.open();
		expect(opened.ok).toBe(true);
		expect(state.browser!.status).toBe("active");
		expect(state.browser!.tabs.length).toBe(1);
		expect(state.browser!.activeTab?.url).toContain("localhost:5173");

		const observed = await manager.observe({});
		expect(observed.observation.summary).toContain("fixture");
		expect(observed.observation.targets[0]!.ref).toBe("e1");
		expect(state.browser!.observation.revision).toBe(1);
		expect(state.browser!.observation.summary).toContain("fixture");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("operations without an open browser fail truthfully (typed, not opaque)", async () => {
		const { state, manager } = makeManager();
		await manager.activate();
		await expect(manager.observe({})).rejects.toBeInstanceOf(AiraBrowserNotOpenError);
		await expect(manager.click({ ref: "e1" })).rejects.toBeInstanceOf(AiraBrowserNotOpenError);
		disposeAiraSessionState(state.sessionId, state);
	});

	it("disabled setting keeps the browser closed with a truthful reason", async () => {
		const { state, manager } = makeManager({
			settings: { enabled: false, context: "auto", autoVerify: true, contextBudget: "compact" },
		});
		await manager.activate();
		const opened = await manager.open();
		expect(opened.ok).toBe(false);
		expect(opened.reason).toContain("disabled");
		expect(state.browser!.availability).toBe("disabled");
		expect(state.browser!.status).toBe("unavailable");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("close() tears the session down and the snapshot follows", async () => {
		const { state, manager } = makeManager();
		await manager.activate();
		await manager.open();
		expect(state.browser!.status).toBe("active");
		const closed = await manager.close();
		expect(closed.ok).toBe(true);
		expect(state.browser!.status).toBe("idle");
		expect(state.browser!.tabs).toEqual([]);
		disposeAiraSessionState(state.sessionId, state);
	});

	it("provider crash degrades the snapshot truthfully", async () => {
		const { state, manager, provider } = makeManager();
		await manager.activate();
		await manager.open();
		provider.simulateCrash();
		expect(state.browser!.status).toBe("degraded");
		expect(state.browser!.reason).toContain("browser process exited");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("CASE A through the manager: steady active browser + unrelated prompt + auto → zero browser context", async () => {
		const { state, manager } = makeManager();
		await manager.activate();
		await manager.open();
		await manager.observe({});
		// Fresh page state after open is injected ONCE (bounded), then the
		// cursor moves and steady state never re-triggers.
		const first = manager.providePromptContext("what is on the page?");
		expect(first).toBeDefined();
		// README work with the browser idle-active: nothing more.
		expect(manager.providePromptContext("update the README")).toBeUndefined();
		disposeAiraSessionState(state.sessionId, state);
	});

	it("CASE B through the manager: unchanged evidence is not duplicated", async () => {
		const { state, manager } = makeManager();
		await manager.activate();
		await manager.open();
		await manager.observe({});
		// A relevant edit opens the signal once.
		manager.applyAgentEvent(editEvent("edit", "/tmp/web/src/App.tsx"));
		manager.applyAgentEvent(editEndEvent("t1"));
		const first = manager.providePromptContext("check the player page");
		expect(first).toBeDefined();
		// Identical evidence + no new signal: dedupe.
		expect(manager.providePromptContext("check again")).toBeUndefined();
		disposeAiraSessionState(state.sessionId, state);
	});

	it("automatic verification: bounded single pass after a relevant edit with a dev server", async () => {
		const { state, manager, provider } = makeManager({
			dev: { running: true, output: "Local: http://localhost:5173\n", processId: "dev-1" },
			providerScript: { verifyNavigations: [] },
		});
		await manager.activate();
		const navigations = provider.verifyNavigations;
		manager.applyAgentEvent(editEvent("edit", "/tmp/web/src/components/Player.tsx"));
		manager.applyAgentEvent(editEndEvent("t1"));
		// Debounce (800ms): wait for the auto-verify pass to run.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(state.browser!.verification.status).toBe("passed");
		expect(navigations).toContain("http://localhost:5173");
		expect(state.browser!.devProcess?.id).toBe("dev-1");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("automatic verification does NOT run without a dev server", async () => {
		const { state, manager } = makeManager({ dev: { running: false, output: "" } });
		await manager.activate();
		manager.applyAgentEvent(editEvent("edit", "/tmp/web/src/components/Player.tsx"));
		manager.applyAgentEvent(editEndEvent("t1"));
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(state.browser!.verification.status).toBe("none");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("automatic verification is gated by autoVerify=false and by mode", async () => {
		const { state, manager } = makeManager({
			dev: { running: true, output: "Local: http://localhost:5173\n" },
			settings: { enabled: true, context: "auto", autoVerify: false, contextBudget: "compact" },
		});
		await manager.activate();
		manager.applyAgentEvent(editEvent("edit", "/tmp/web/src/App.tsx"));
		manager.applyAgentEvent(editEndEvent("t1"));
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(state.browser!.verification.status).toBe("none");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("ambient eligibility stays off for backend-only edits even with the browser active", async () => {
		const { state, manager } = makeManager({ dev: { running: true, output: "Local: http://localhost:5173\n" } });
		await manager.activate();
		await manager.open();
		// One bounded injection for the fresh page state (cursor moves).
		expect(manager.providePromptContext("first look")).toBeDefined();
		// A README edit is not browser-relevant: no new signal, zero tokens.
		manager.applyAgentEvent(editEvent("edit", "/tmp/web/README.md"));
		manager.applyAgentEvent(editEndEvent("t1"));
		expect(manager.providePromptContext("the readme")).toBeUndefined();
		disposeAiraSessionState(state.sessionId, state);
	});

	it("explicit verify() navigates the discovered URL and records evidence", async () => {
		const { state, manager, provider } = makeManager({
			dev: { running: true, output: "listening on http://localhost:4173\n", processId: "dev-1" },
			providerScript: { verifyNavigations: [] },
		});
		await manager.activate();
		const result = await manager.verify();
		expect(result.ok).toBe(true);
		expect(provider.verifyNavigations).toContain("http://localhost:4173");
		expect(state.browser!.verification.status).toBe("passed");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("verify without a dev process reports needs-url truthfully", async () => {
		const { state, manager } = makeManager({ dev: { running: false, output: "" } });
		await manager.activate();
		const result = await manager.verify();
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("no local URL");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("screenshot records a path reference (never bytes) in the snapshot", async () => {
		const { state, manager } = makeManager({ providerScript: {} });
		await manager.activate();
		await manager.open();
		const shot = await manager.screenshot();
		expect(shot.ok).toBe(true);
		expect(shot.path).toContain(".jpg");
		expect(state.browser!.screenshot.lastPath).toBe(shot.path);
		disposeAiraSessionState(state.sessionId, state);
	});

	it("dispose closes the underlying provider once, resilient to double dispose", async () => {
		let disposeCalls = 0;
		const { state, manager } = makeManager({
			providerScript: {
				disposeCalls: () => {
					disposeCalls += 1;
				},
			},
		});
		await manager.activate();
		await manager.open();
		await manager.dispose();
		await manager.dispose();
		expect(disposeCalls).toBe(1);
		disposeAiraSessionState(state.sessionId, state);
	});

	it("notifies listeners with every published snapshot (UI seam)", async () => {
		const { state, manager } = makeManager();
		const seen: string[] = [];
		const unsubscribe = manager.subscribe((status) => seen.push(status.status));
		await manager.activate();
		await manager.open();
		await manager.close();
		unsubscribe();
		expect(seen).toContain("active");
		expect(seen).toContain("idle");
		disposeAiraSessionState(state.sessionId, state);
	});
});
