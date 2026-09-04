/**
 * Phase 12.x — Agent Inspector: browser, transcript, entry behavior, scroll
 * restoration, workbench marker, and zero-token property.
 *
 * The TUI holds only UI selection state; the oracle for everything rendered
 * is the (faked) orchestration handle. Opening, switching, and closing the
 * inspector must never schedule model work or consume tokens.
 */
import { Container, ScrollView, setKeybindings, Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { AiraChildEvent } from "../../src/aira/orchestration/events.ts";
import type { AiraOrchestrationHandle } from "../../src/aira/orchestration/manager.ts";
import type { AiraChildRun, AiraOrchestrationStatus } from "../../src/aira/orchestration/types.ts";
import type { AiraSessionState } from "../../src/aira/state.ts";
import { agentsPanel } from "../../src/aira/ui/panels.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { AgentInspectorController } from "../../src/modes/interactive/agent-inspector/agent-inspector.ts";
import { AiraConversationTitleComponent } from "../../src/modes/interactive/components/aira-shell.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, setTheme } from "../../src/modes/interactive/theme/theme.ts";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const plain = (text: string): string => text.replace(ANSI, "");

function statusOf(runs: readonly AiraChildRun[]): AiraOrchestrationStatus {
	const running = runs.filter((run) => run.status === "running").length;
	const pending = runs.filter((run) => run.status === "pending").length;
	return {
		enabled: true,
		status: running + pending > 0 ? "active" : "idle",
		runningCount: running,
		queuedCount: pending,
		maxConcurrency: 2,
		children: runs.map((run) => ({
			id: run.id,
			taskId: run.taskId ?? run.id,
			role: run.role,
			task: run.task,
			status: run.status,
			phase: run.phase,
			model: undefined,
			elapsedMs: run.durationMs,
			dependencies: [],
			...(run.activity ? { activity: run.activity } : {}),
			...(run.error ? { error: run.error } : {}),
		})),
		recentResults: [],
		failures: runs
			.filter((run) => run.error)
			.map((run) => ({
				id: run.id,
				taskId: run.taskId ?? run.id,
				role: run.role,
				category: run.error!.category,
				message: run.error!.message,
				timestamp: run.completedAt ?? Date.now(),
				retryable: false,
			})),
		summary: running + pending > 0 ? `${running} running · ${pending} queued` : "idle",
		updatedAt: Date.now(),
	};
}

function runOf(
	partial: Partial<AiraChildRun> & { id: string; role: AiraChildRun["role"]; task: string },
): AiraChildRun {
	return {
		taskId: partial.id,
		createdAt: partial.createdAt ?? Date.now(),
		dependencies: [],
		status: partial.status ?? "pending",
		phase: partial.phase ?? "waiting-capacity",
		model: undefined,
		...partial,
	};
}

class FakeOrchestration implements AiraOrchestrationHandle {
	runs: AiraChildRun[] = [];
	eventsByRun = new Map<string, AiraChildEvent[]>();
	subscribers = new Set<(status: AiraOrchestrationStatus) => void>();
	eventSubscribers = new Map<string, Set<(event: AiraChildEvent) => void>>();
	scheduleCalls = 0;

	async schedule(): Promise<never> {
		this.scheduleCalls += 1;
		throw new Error("inspector must never schedule");
	}
	cancel(): never {
		throw new Error("not used");
	}
	list(): readonly AiraChildRun[] {
		return this.runs;
	}
	get(runId: string): AiraChildRun | undefined {
		return this.runs.find((run) => run.id === runId);
	}
	status(): AiraOrchestrationStatus {
		return statusOf(this.runs);
	}
	events(runId: string): readonly AiraChildEvent[] {
		return this.eventsByRun.get(runId) ?? [];
	}
	subscribeEvents(runId: string, listener: (event: AiraChildEvent) => void): () => void {
		const listeners = this.eventSubscribers.get(runId) ?? new Set<(event: AiraChildEvent) => void>();
		listeners.add(listener);
		this.eventSubscribers.set(runId, listeners);
		return () => {
			listeners.delete(listener);
		};
	}
	subscribe(listener: (status: AiraOrchestrationStatus) => void): () => void {
		this.subscribers.add(listener);
		return () => {
			this.subscribers.delete(listener);
		};
	}
	dispose(): Promise<void> {
		return Promise.resolve();
	}

	/** Test helper: emit a live event to one run's buffer + subscribers. */
	emit(runId: string, event: AiraChildEvent): void {
		const buffer = this.eventsByRun.get(runId) ?? [];
		buffer.push(event);
		this.eventsByRun.set(runId, buffer);
		for (const listener of this.eventSubscribers.get(runId) ?? []) {
			listener(event);
		}
	}
}

interface Harness {
	orch: FakeOrchestration;
	inspector: AgentInspectorController;
	document: Container;
	/** The root conversation viewport (detached while the inspector is open). */
	rootScrollView: ScrollView;
	/** The viewport currently mounted by the inspector (undefined = root). */
	activeViewport: () => ScrollView | undefined;
	title: AiraConversationTitleComponent;
	editorHint: () => string;
	renderRequests: () => number;
}

function makeHarness(options: { runs?: AiraChildRun[] } = {}): Harness {
	setTheme("dark");
	const keybindings = KeybindingsManager.create();
	setKeybindings(keybindings);
	const orch = new FakeOrchestration();
	orch.runs = options.runs ?? [];
	const document = new Container();
	const rootChild = new Text("ROOT-CONVERSATION", 0, 0);
	document.addChild(rootChild);
	const rootScrollView = new ScrollView(document, { follow: "end", primary: true });
	const title = new AiraConversationTitleComponent(() => true);
	const editorContainer = new Container();
	const editor = new Text("EDITOR", 0, 0);
	let renderRequests = 0;
	let activeViewport: ScrollView | undefined;
	const ui = {
		setFocus: () => undefined,
		requestRender: () => {
			renderRequests += 1;
		},
		invalidate: () => {
			renderRequests += 1;
		},
	} as never;
	const session = { airaOrchestration: orch } as never;
	const inspector = new AgentInspectorController({
		session,
		ui,
		document,
		rootChildren: [rootChild],
		swapViewport: (active) => {
			activeViewport = active;
		},
		title,
		editorContainer,
		editor,
		requestRender: () => {
			renderRequests += 1;
		},
		invalidate: () => {
			renderRequests += 1;
		},
		onInspectedChange: () => undefined,
	});
	const editorHint = () => plain(editorContainer.children.flatMap((child) => child.render(80)).join("\n"));
	return {
		orch,
		inspector,
		document,
		rootScrollView,
		activeViewport: () => activeViewport,
		title,
		editorHint,
		renderRequests: () => renderRequests,
	};
}

afterEach(() => {
	// Stray keybindings must not leak between tests.
	setKeybindings(KeybindingsManager.create());
});

describe("Agent Inspector browser (Phase 12.x)", () => {
	it("does not open without inspectable children (normal editor behavior preserved)", () => {
		const harness = makeHarness();
		expect(harness.inspector.openBrowser()).toBe(false);
		expect(harness.document.children.length).toBe(1);
		expect(harness.renderRequests()).toBe(0);
		expect(harness.activeViewport()).toBeUndefined();
	});

	it("opens the browser when children exist and lists running/queued/waiting/failed truthfully", () => {
		const now = Date.now();
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r-run",
					role: "explore",
					task: "inspect TUI renderer",
					status: "running",
					phase: "running",
					startedAt: now - 102_000,
					activity: "tool",
				}),
				runOf({
					id: "r-queued",
					role: "review",
					task: "regression review",
					status: "pending",
					phase: "waiting-capacity",
					createdAt: now,
				}),
				runOf({
					id: "r-dep",
					role: "implement",
					task: "permission UX",
					status: "pending",
					phase: "waiting-dependency",
					dependencies: ["upstream"],
					createdAt: now,
				}),
				runOf({
					id: "r-failed",
					role: "implement",
					task: "project analysis",
					status: "failed",
					phase: "settled",
					completedAt: now - 5_000,
					durationMs: 12_000,
					error: { category: "tool-budget-exceeded", message: "child exceeded its tool budget", retryable: false },
				}),
			],
		});
		expect(harness.inspector.openBrowser()).toBe(true);
		const lines = harness.document.children.map((child) => plain(child.render(80).join("\n"))).join("\n");
		expect(lines).toContain("AGENTS");
		expect(lines).toContain("1 running · 2 queued"); // summary counts
		expect(lines).toContain("● explore");
		expect(lines).toContain("inspect TUI renderer");
		expect(lines).toContain("running · tool");
		expect(lines).toContain("1m42s");
		expect(lines).toContain("review");
		expect(lines).toContain("waiting-capacity");
		expect(lines).toContain("waiting-dependency");
		expect(lines).toContain("✕ implement");
		expect(lines).toContain("tool-budget-exceeded");
		// Header title flips away from CONVERSATION.
		expect(plain(harness.title.render(40).join("\n"))).toContain("AGENTS");
		expect(plain(harness.title.render(40).join("\n"))).not.toContain("CONVERSATION");
	});

	it("browser Enter selects the child and opens its transcript view", () => {
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			],
		});
		expect(harness.inspector.openBrowser()).toBe(true);
		const kb = KeybindingsManager.create();
		setKeybindings(kb);
		const browser = harness.document.children[0]!;
		key(browser, "\x1b[B"); // down (single row: no-op)
		key(browser, "\r"); // enter
		expect(harness.inspector.inspectedRunId).toBe("r1");
		expect(plain(harness.title.render(40).join("\n"))).toContain("AGENT · EXPLORE");
	});

	it("browser Esc closes directly to the root conversation", () => {
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			],
		});
		expect(harness.inspector.openBrowser()).toBe(true);
		key(harness.document.children[0]!, "\x1b"); // escape
		expect(harness.inspector.inspectedRunId).toBeUndefined();
		expect(plain(harness.document.children.map((child) => child.render(40).join("\n")).join("\n"))).toContain(
			"ROOT-CONVERSATION",
		);
		expect(plain(harness.title.render(40).join("\n"))).toContain("CONVERSATION");
	});

	it("stale child ids degrade safely back to the browser", () => {
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
				runOf({
					id: "r2",
					role: "review",
					task: "check it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			],
		});
		expect(harness.inspector.openBrowser()).toBe(true);
		harness.orch.runs = [harness.orch.runs[1]!]; // r1 evicted while browsing
		harness.inspector.openChild("r1");
		// The browser remains (no transcript for the vanished child).
		expect(harness.inspector.inspectedRunId).toBeUndefined();
		expect(plain(harness.title.render(40).join("\n"))).toContain("AGENTS");
	});
});

/** Focusable-input shorthand: the Components interface leaves handleInput optional. */
function key(component: unknown, data: string): void {
	(component as { handleInput(data: string): void }).handleInput(data);
}

/** View a child through the real browser flow (openBrowser → Enter). */
function viewChild(harness: Harness): void {
	expect(harness.inspector.openBrowser()).toBe(true);
	key(harness.document.children[0], "\r");
}

describe("Agent Inspector transcript (Phase 12.x)", () => {
	it("header identifies role and task; live events render (thinking, tools, results, failure, completion)", () => {
		const now = Date.now();
		const run = runOf({
			id: "r1",
			role: "explore",
			task: "inspect TUI renderer",
			status: "running",
			phase: "running",
			startedAt: now,
		});
		const harness = makeHarness({ runs: [run] });
		harness.orch.emit("r1", { kind: "thinking", at: now, text: "tracing the viewport layout" });
		harness.orch.emit("r1", {
			kind: "tool_call",
			at: now,
			toolCallId: "c1",
			name: "read",
			args: "packages/tui/src/tui.ts",
		});
		harness.orch.emit("r1", {
			kind: "tool_result",
			at: now,
			toolCallId: "c1",
			name: "read",
			isError: false,
			summary: "ok",
		});
		harness.orch.emit("r1", { kind: "tool_call", at: now, toolCallId: "c2", name: "bash", args: "npm run check" });
		harness.orch.emit("r1", {
			kind: "tool_result",
			at: now,
			toolCallId: "c2",
			name: "bash",
			isError: true,
			summary: "Error: exit code 2",
		});
		viewChild(harness);
		const lines = plain(harness.document.children.map((child) => child.render(80).join("\n")).join("\n"));
		expect(lines).toContain("AGENT · EXPLORE");
		expect(lines).toContain("inspect TUI renderer");
		expect(lines).toContain("Thinking");
		expect(lines).toContain("tracing the viewport layout");
		expect(lines).toContain("✓ read");
		expect(lines).toContain("packages/tui/src/tui.ts");
		expect(lines).toContain("✕ bash");
		expect(lines).toContain("Error: exit code 2");
		expect(lines).toContain("running");
	});

	it("failure and completion appear without leaving the view", () => {
		const now = Date.now();
		const harness = makeHarness({
			runs: [
				runOf({ id: "r1", role: "review", task: "check", status: "running", phase: "running", startedAt: now }),
			],
		});
		viewChild(harness);
		harness.orch.runs[0]!.status = "failed";
		harness.orch.runs[0]!.phase = "settled";
		harness.orch.runs[0]!.error = {
			category: "tool-budget-exceeded",
			message: "child exceeded its tool budget",
			retryable: false,
		};
		harness.orch.emit("r1", {
			kind: "failure",
			at: now,
			category: "tool-budget-exceeded",
			message: "child exceeded its tool budget",
		});
		const lines = plain(harness.document.children.map((child) => child.render(80).join("\n")).join("\n"));
		expect(lines).toContain("tool-budget-exceeded");
		expect(harness.inspector.inspectedRunId).toBe("r1"); // still viewing
	});

	it("Esc from the child view returns DIRECTLY to root (no browser step)", () => {
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			],
		});
		viewChild(harness);
		expect(harness.inspector.inspectedRunId).toBe("r1");
		key(harness.document.children[0]!, "\x1b");
		expect(harness.inspector.inspectedRunId).toBeUndefined();
		expect(plain(harness.document.children.map((child) => child.render(40).join("\n")).join("\n"))).toContain(
			"ROOT-CONVERSATION",
		);
	});

	it("no composer input path exists while inspecting (read-only strip)", () => {
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			],
		});
		expect(harness.inspector.openBrowser()).toBe(true);
		expect(harness.editorHint()).toContain("navigate");
		viewChild(harness);
		expect(harness.editorHint()).toContain("view-only");
	});
});

describe("Agent Inspector entry behavior (Phase 12.x)", () => {
	it("a bare Left Arrow on an empty composer opens the browser", () => {
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			],
		});
		setTheme("dark");
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor({} as never, getEditorTheme(), keybindings, { paddingX: 0 });
		editor.onContextualLeftArrow = () => harness.inspector.openBrowser();
		expect(harness.inspector.inspectedRunId).toBeUndefined();
		key(editor, "\x1b[D"); // Left on empty composer at start
		expect(harness.document.children.length).toBe(1); // browser swapped in
		const lines = plain(harness.document.children.map((child) => child.render(40).join("\n")).join("\n"));
		expect(lines).toContain("AGENTS");
	});

	it("Left Arrow with non-empty composer keeps normal editor behavior", () => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor({} as never, getEditorTheme(), keybindings, { paddingX: 0 });
		let opened = false;
		editor.onContextualLeftArrow = () => {
			opened = true;
			return true;
		};
		editor.setText("hello");
		key(editor, "\x1b[D"); // Left inside non-empty text: cursor moves
		expect(opened).toBe(false);
		expect(editor.getText()).toBe("hello"); // text untouched
		expect(editor.atEmptyStart()).toBe(false);
	});

	it("cursor at document start on an empty editor is the only trigger", () => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor({} as never, getEditorTheme(), keybindings, { paddingX: 0 });
		expect(editor.atEmptyStart()).toBe(true);
		editor.setText("x");
		expect(editor.atEmptyStart()).toBe(false);
		editor.setText("");
		editor.insertTextAtCursor?.("y");
		expect(editor.atEmptyStart()).toBe(false);
	});
});

describe("Agent Inspector scrolling (Phase 12.x)", () => {
	/** Simulate the layout engine pass on a mounted viewport. */
	function layoutViewport(scrollView: ScrollView, content: { render(width: number): string[] }, viewport = 10): void {
		scrollView.updateLayout(content.render(80).filter((line) => line.length > 0).length, viewport, () => undefined);
	}

	it("root scroll position survives inspection untouched (per-view viewports)", () => {
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			],
		});
		// Make the root document scrollable by replacing it with a tall doc.
		const tallRoot = new Text(Array.from({ length: 60 }, (_, index) => `root-line-${index}`).join("\n"), 0, 0);
		harness.document.clear();
		harness.document.addChild(tallRoot);
		layoutViewport(harness.rootScrollView, tallRoot);
		// Read history: scroll away from the live bottom.
		harness.rootScrollView.scrollBy(-10);
		layoutViewport(harness.rootScrollView, tallRoot);
		const savedTop = harness.rootScrollView.scrollTop;
		expect(savedTop).toBe(40);
		expect(harness.rootScrollView.isFollowingEnd).toBe(false);
		// Enter the inspector: the root viewport is detached, not modified.
		expect(harness.inspector.openBrowser()).toBe(true);
		expect(harness.activeViewport()).not.toBe(harness.rootScrollView);
		expect(harness.rootScrollView.scrollTop).toBe(40);
		expect(harness.rootScrollView.isFollowingEnd).toBe(false);
		// Child view: still detached.
		key(harness.document.children[0]!, "\r");
		expect(harness.rootScrollView.scrollTop).toBe(40);
		// Close: back to the root viewport (undefined = root in the harness)
		// with its position intact.
		key(harness.document.children[0]!, "\x1b");
		expect(harness.activeViewport()).toBeUndefined();
		layoutViewport(harness.rootScrollView, tallRoot);
		expect(harness.rootScrollView.scrollTop).toBe(40);
		expect(harness.rootScrollView.isFollowingEnd).toBe(false);
	});

	it("child transcript has an independent viewport: follows new output, stops when scrolled up", () => {
		const now = Date.now();
		const harness = makeHarness({
			runs: [
				runOf({ id: "r1", role: "explore", task: "map it", status: "running", phase: "running", startedAt: now }),
			],
		});
		viewChild(harness);
		const child = harness.activeViewport()!;
		expect(child).not.toBe(harness.rootScrollView);
		// Small viewport so the transcript actually overflows (scrolling needs
		// content taller than the pane).
		layoutViewport(child, harness.document, 3);
		expect(child.isFollowingEnd).toBe(true);
		harness.orch.emit("r1", { kind: "text", at: now, text: "line1\nline2\nline3" });
		layoutViewport(child, harness.document, 3);
		expect(child.isFollowingEnd).toBe(true);
		child.scrollBy(-2);
		layoutViewport(child, harness.document, 3);
		expect(child.isFollowingEnd).toBe(false);
		harness.orch.emit("r1", { kind: "text", at: now, text: "more output while reading history" });
		layoutViewport(child, harness.document, 3);
		// Not yanked to the bottom.
		expect(child.isFollowingEnd).toBe(false);
	});
});

describe("Agent Inspector integration (Phase 12.x)", () => {
	it("inspected child receives the Workbench › marker (UI selection only)", () => {
		const state = {
			orchestration: statusOf([
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
					activity: "tool",
				}),
				runOf({
					id: "r2",
					role: "review",
					task: "check it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			]),
		} as AiraSessionState;
		const marked = agentsPanel(state, "r2");
		const rows = marked?.rows ?? [];
		expect(rows.some((row) => row.value.includes("› ● review"))).toBe(true);
		expect(rows.some((row) => row.value.includes("● explore"))).toBe(true);
		expect(rows.some((row) => row.value.includes("› ● explore"))).toBe(false);
		const unmarked = agentsPanel(state, undefined);
		expect(unmarked?.rows.some((row) => row.value.includes("›"))).toBe(false);
	});

	it("viewing consumes zero model calls (no schedule/dispatch paths)", () => {
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "map it",
					status: "running",
					phase: "running",
					startedAt: Date.now(),
				}),
			],
		});
		expect(harness.inspector.openBrowser()).toBe(true);
		viewChild(harness);
		harness.orch.emit("r1", { kind: "thinking", at: Date.now(), text: "working" });
		for (let index = 0; index < 10; index += 1) {
			harness.orch.emit("r1", { kind: "text", at: Date.now(), text: `chunk ${index}` });
		}
		harness.inspector.close();
		expect(harness.orch.scheduleCalls).toBe(0);
	});

	it("switching children subscribes to exactly the viewed child and unsubscribes on close", () => {
		const now = Date.now();
		const harness = makeHarness({
			runs: [
				runOf({ id: "r1", role: "explore", task: "map it", status: "running", phase: "running", startedAt: now }),
				runOf({ id: "r2", role: "review", task: "check it", status: "running", phase: "running", startedAt: now }),
				runOf({
					id: "r3",
					role: "research",
					task: "study it",
					status: "running",
					phase: "running",
					startedAt: now,
				}),
			],
		});
		expect(harness.inspector.openBrowser()).toBe(true);
		viewChild(harness);
		expect(harness.inspector.inspectedRunId).toBe("r1");
		expect(harness.orch.eventSubscribers.get("r1")?.size).toBe(1);
		expect(harness.orch.eventSubscribers.get("r2")).toBeUndefined();
		// Esc → root, then Left (openBrowser) → browser, down twice → r3, Enter.
		key(harness.document.children[0]!, "\x1b");
		expect(harness.inspector.openBrowser()).toBe(true);
		key(harness.document.children[0]!, "\x1b[B");
		key(harness.document.children[0]!, "\x1b[B");
		key(harness.document.children[0]!, "\r");
		expect(harness.inspector.inspectedRunId).toBe("r3");
		expect(harness.orch.eventSubscribers.get("r1")?.size ?? 0).toBe(0);
		expect(harness.orch.eventSubscribers.get("r3")?.size).toBe(1);
		harness.inspector.close();
		expect(harness.orch.eventSubscribers.get("r3")?.size ?? 0).toBe(0);
	});

	it("narrow terminals render without throwing", () => {
		const now = Date.now();
		const harness = makeHarness({
			runs: [
				runOf({
					id: "r1",
					role: "explore",
					task: "a very long task description that must be truncated gracefully",
					status: "failed",
					phase: "settled",
					completedAt: now,
					durationMs: 1000,
					error: { category: "driver", message: "boom", retryable: false },
				}),
			],
		});
		expect(harness.inspector.openBrowser()).toBe(true);
		expect(() => harness.document.children[0]!.render(12)).not.toThrow();
		key(harness.document.children[0]!, "\r");
		expect(() => harness.document.children[0]!.render(12)).not.toThrow();
	});
});
