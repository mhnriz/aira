import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiraGoalSnapshot } from "../../src/aira/goal/types.ts";
import { type AiraSessionState, acquireAiraSessionState, disposeAiraSessionState } from "../../src/aira/state.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { DEFAULT_WORKBENCH_WIDTH } from "../../src/core/settings-manager.ts";
import {
	WorkbenchController,
	type WorkbenchControllerOptions,
} from "../../src/modes/interactive/workbench/controller.ts";

function goalFixture(objective: string): AiraGoalSnapshot {
	return {
		enabled: true,
		auto: "smart",
		status: "active",
		id: "goal-1",
		objective,
		round: 1,
		maxRounds: 2,
		startedAt: undefined,
		updatedAt: 0,
		completedAt: undefined,
		stopReason: undefined,
		waiting: undefined,
		budget: { tokens: undefined, maxDurationMs: undefined },
		usage: { consumedTokens: 0, remainingTokens: 0, sources: [] },
		revision: undefined,
		tasks: { completed: 0, active: 0, total: 0 },
		verification: { verdict: "pass", stale: false, summary: "ok", missingEvidence: [], lastError: undefined },
		staleCompletion: false,
		needsUserInput: false,
		mode: "build",
		lastEvent: undefined,
		persistence: { enabled: false, status: "ok", path: undefined, error: undefined },
		summary: objective,
	};
}

let sessionCounter = 0;
const activeStates = new Map<string, AiraSessionState>();

afterEach(() => {
	for (const [id, state] of activeStates) {
		disposeAiraSessionState(id, state);
	}
	activeStates.clear();
});

function createHarness() {
	const sessionId = `wb-reconcile-${sessionCounter++}`;
	const state: AiraSessionState = acquireAiraSessionState(sessionId, "startup");
	activeStates.set(sessionId, state);

	let agentListener: (() => void) | undefined;
	let focused = false;
	let following = true;
	const requestRender = vi.fn();
	const layoutChanged = vi.fn();
	let contextPercent = 0;
	const settings = {
		enabled: true,
		showOnStartup: true,
		density: "comfortable" as const,
		width: DEFAULT_WORKBENCH_WIDTH,
	};

	const session = {
		sessionId,
		subscribe: (listener: () => void) => {
			agentListener = listener;
			return () => {
				agentListener = undefined;
			};
		},
		settingsManager: {
			getWorkbenchSettings: () => ({ ...settings }),
			setWorkbenchSettings: (patch: Partial<typeof settings>) => Object.assign(settings, patch),
			getFullscreenScrollbar: () => false,
		},
		sessionManager: { getCwd: () => "/tmp/aira-reconcile" },
		state: { model: undefined },
		thinkingLevel: "off",
		autoCompactionEnabled: true,
		getContextUsage: () => {
			contextPercent = (contextPercent + 1) % 100;
			return { percent: contextPercent, contextWindow: 1000 };
		},
	} as unknown as AgentSession;

	const options: WorkbenchControllerOptions = {
		session,
		footerComponent: new Text("footer"),
		dockAnchorComponent: new Text("dock"),
		getBranch: () => "main",
		getFooterLineCount: () => 2,
		getTranscriptFollowing: () => following,
		getFocused: () => focused,
		getInspectedRunId: () => undefined,
		requestRender,
		layoutChanged,
	};

	const controller = new WorkbenchController(options);
	const terminal = { columns: 200, rows: 50 };
	// Plain object (not AiraTuiMainScreen): keeps the test on the reconcile path only.
	controller.bindTui({ mode: "fullscreen", terminal, footerStartRow: 0 } as never);

	requestRender.mockClear();
	controller.attach();
	// attach() reconciles once; ignore that initial frame so tests start from a settled rail.
	requestRender.mockClear();
	layoutChanged.mockClear();

	return {
		state,
		controller,
		requestRender,
		layoutChanged,
		fireAgentEvent: () => agentListener?.(),
		setFocused: (value: boolean) => {
			focused = value;
		},
		setFollowing: (value: boolean) => {
			following = value;
		},
	};
}

describe("Workbench reconcile invalidation", () => {
	it("does not request a render for a stream tick that leaves the rail unchanged", () => {
		const h = createHarness();
		h.fireAgentEvent();
		h.fireAgentEvent();
		h.fireAgentEvent();
		expect(h.requestRender).not.toHaveBeenCalled();
		expect(h.layoutChanged).not.toHaveBeenCalled();
	});

	it("does not request a render for repeated identical reconciles", () => {
		const h = createHarness();
		h.controller.setVisible(true);
		h.controller.setVisible(true);
		h.controller.setVisible(true);
		expect(h.requestRender).not.toHaveBeenCalled();
	});

	it("updates immediately when the rail projection changes", () => {
		const h = createHarness();
		h.state.goal = goalFixture("first goal");
		h.fireAgentEvent();
		expect(h.requestRender).toHaveBeenCalledTimes(1);

		h.requestRender.mockClear();
		h.state.goal = goalFixture("second goal");
		h.fireAgentEvent();
		expect(h.requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not re-request a render when the same goal value is republished", () => {
		const h = createHarness();
		h.state.goal = goalFixture("stable goal");
		h.fireAgentEvent();
		h.requestRender.mockClear();

		h.state.goal = goalFixture("stable goal");
		h.fireAgentEvent();
		expect(h.requestRender).not.toHaveBeenCalled();
	});

	it("requests a render when title focus/follow state changes even if panels are stable", () => {
		const h = createHarness();
		h.setFocused(true);
		h.fireAgentEvent();
		expect(h.requestRender).toHaveBeenCalledTimes(1);

		h.requestRender.mockClear();
		h.setFocused(true);
		h.fireAgentEvent();
		expect(h.requestRender).not.toHaveBeenCalled();

		h.setFocused(false);
		h.setFollowing(false);
		h.fireAgentEvent();
		expect(h.requestRender).toHaveBeenCalledTimes(1);
	});

	it("still repaints when Workbench is toggled on and off", () => {
		const h = createHarness();
		expect(h.controller.isVisibleNow()).toBe(true);

		h.controller.setEnabled(false);
		expect(h.controller.isVisibleNow()).toBe(false);
		expect(h.requestRender).toHaveBeenCalledTimes(1);
		expect(h.layoutChanged).toHaveBeenCalled();

		h.requestRender.mockClear();
		h.layoutChanged.mockClear();
		h.controller.setEnabled(true);
		expect(h.controller.isVisibleNow()).toBe(true);
		expect(h.requestRender).toHaveBeenCalledTimes(1);
		expect(h.layoutChanged).toHaveBeenCalled();
	});

	it("keeps a stable rail across the initial streamed context ticks", () => {
		const h = createHarness();
		// Context percent advances on every call (the real per-token input) but is
		// not part of the rail surface, so it must not churn the rail.
		for (let i = 0; i < 50; i++) h.fireAgentEvent();
		expect(h.requestRender).not.toHaveBeenCalled();
	});
});
