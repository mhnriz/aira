/**
 * Agent Inspector — controller (interactive mode only).
 *
 * Owns the inspector's UI state (browser open, which child is viewed) and the
 * LEFT conversation viewport swap inside the existing Phase 12.1 scroll shell:
 *
 *   root conversation  ──Left (empty composer)──▶  Agent Browser
 *   Agent Browser      ──Enter──▶                  child transcript
 *   child transcript   ──Esc──▶                    root conversation (direct)
 *   Agent Browser      ──Esc──▶                    root conversation (direct)
 *
 * The Workbench pane is untouched: it keeps rendering the ROOT session's live
 * canonical state. The composer is replaced by a read-only hint strip while
 * the inspector is open, so no input path into a child exists.
 *
 * Each view owns its own ScrollView behind the shared conversation pane slot
 * (the host swaps the layout node): the root conversation's scroll position
 * and follow state survive inspection untouched, the child transcript gets an
 * independent viewport with the existing follow/unread/PageUp/PageDown/wheel
 * semantics, and nothing is ever "yanked" by new output while reading history.
 *
 * Per-run event subscriptions attach only while viewing that child and are
 * removed on switch/close/dispose; a 1s unref'd ticker drives elapsed while
 * open. This controller holds NO engineering truth and consumes zero model
 * tokens: everything it renders comes from the orchestration manager's
 * snapshot, run records, and event buffers.
 */
import { type Component, type Container, ScrollView, Text, type TUI } from "@earendil-works/pi-tui";
import type { AiraChildRun, AiraOrchestrationStatus } from "../../../aira/orchestration/types.ts";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { AiraConversationTitleComponent } from "../components/aira-shell.ts";
import { keyText } from "../components/keybinding-hints.ts";
import { theme } from "../theme/theme.ts";
import { AgentBrowserComponent } from "./agent-browser.ts";
import { AgentTranscriptComponent } from "./agent-transcript.ts";

export type AgentInspectorView = "closed" | "browser" | { runId: string };

export interface AgentInspectorOptions {
	session: AgentSession;
	/** TUI reference (createInteractiveTuiReference). */
	ui: TUI;
	/** Conversation document container (inside the transcript ScrollView). */
	document: Container;
	/** Children restored when the inspector closes (loaded resources + chat). */
	rootChildren: readonly Component[];
	/**
	 * Host swaps the conversation pane's mounted ScrollView. undefined =
	 * back to the root transcript viewport. Each inspector view supplies its
	 * own ScrollView so scroll state never needs save/restore.
	 */
	swapViewport: (active: ScrollView | undefined) => void;
	title: AiraConversationTitleComponent;
	editorContainer: Container;
	editor: Component;
	requestRender: () => void;
	invalidate: () => void;
	/** Called when the inspected child changes (footer + Workbench marker). */
	onInspectedChange: () => void;
}

const INSPECTOR_TICK_MS = 1_000;
/** Bounded events shown in one transcript rendering pass (ring caps further). */
const MAX_TRANSCRIPT_EVENTS_RENDERED = 400;

export class AgentInspectorController {
	private readonly options: AgentInspectorOptions;
	private readonly browser: AgentBrowserComponent;
	private readonly browserScrollView: ScrollView;
	private view: AgentInspectorView = "closed";
	private transcript: AgentTranscriptComponent | undefined;
	private childScrollView: ScrollView | undefined;
	/**
	 * Last canonical snapshot delivered by the manager subscription. Cached so
	 * browser refreshes never call orch.status() (which publishes — calling it
	 * from inside the subscription callback would recurse unboundedly).
	 */
	private snapshot: AiraOrchestrationStatus | undefined;
	private unsubscribe: Array<() => void> = [];
	private ticker: NodeJS.Timeout | undefined;

	constructor(options: AgentInspectorOptions) {
		this.options = options;
		this.browser = new AgentBrowserComponent({
			getRuns: () => this.runs(),
			getSummary: () => {
				const snapshot = this.snapshot;
				if (!snapshot) return undefined;
				if (snapshot.runningCount > 0 || snapshot.queuedCount > 0) {
					return `${snapshot.runningCount} running · ${snapshot.queuedCount} queued`;
				}
				return snapshot.summary;
			},
			onSelect: (runId) => this.openChild(runId),
			onCancel: () => this.close(),
		});
		this.browserScrollView = new ScrollView(this.browser, {
			follow: "end",
			primary: true,
			overscroll: "chain",
		});
	}

	private orch() {
		return this.options.session.airaOrchestration;
	}

	private runs(): readonly AiraChildRun[] {
		return this.orch()?.list() ?? [];
	}

	/** The run currently being viewed (undefined in root/browser views). */
	get inspectedRunId(): string | undefined {
		return typeof this.view === "object" ? this.view.runId : undefined;
	}

	/** Footer label ("VIEW explore") or undefined at root. */
	get inspectedLabel(): string | undefined {
		const run = this.inspectedRun();
		return run ? `VIEW ${run.role}` : undefined;
	}

	/**
	 * Open the Agent Browser. Returns true when the browser opened; false when
	 * there is nothing inspectable (normal editor behavior must be kept).
	 */
	openBrowser(): boolean {
		if (this.view !== "closed") {
			// Already inside the inspector (e.g. re-entry): keep the browser.
			return true;
		}
		const orch = this.orch();
		if (!orch || orch.list().length === 0) {
			return false;
		}
		this.showBrowser();
		return true;
	}

	/**
	 * Open one child's transcript (from the browser). A stale/unknown run
	 * id degrades safely back to the browser (never a stuck view).
	 */
	openChild(runId: string): void {
		const run = this.runs().find((candidate) => candidate.id === runId);
		if (!run) {
			// Stale id: degrade safely back to the browser.
			this.showBrowser();
			return;
		}
		this.view = { runId };
		this.teardownViewSubscriptions();
		this.transcript = new AgentTranscriptComponent({
			getRun: () => this.orch()?.get(runId),
			getEvents: () => (this.orch()?.events(runId) ?? []).slice(-MAX_TRANSCRIPT_EVENTS_RENDERED),
			getElapsedNow: () => Date.now(),
			onCancel: () => this.close(),
		});
		this.childScrollView = new ScrollView(this.transcript, {
			follow: "end",
			primary: true,
			overscroll: "chain",
		});
		this.options.document.clear();
		this.options.document.addChild(this.transcript);
		this.options.title.setInspectorHeader(`AGENT · ${run.role.toUpperCase()}`, run.task);
		this.setComposerHint(`view-only · ${theme.fg("dim", keyText("tui.select.cancel"))} return to conversation`);
		this.options.swapViewport(this.childScrollView);
		this.childScrollView.scrollToEnd();
		this.options.ui.setFocus(this.transcript);
		this.syncViewSubscriptions();
		this.options.invalidate();
		this.options.requestRender();
		this.options.onInspectedChange();
	}

	/** Close the inspector and return directly to the root conversation. */
	close(): void {
		if (this.view === "closed") {
			return;
		}
		this.view = "closed";
		this.teardownViewSubscriptions();
		this.stopTicker();
		this.options.document.clear();
		for (const child of this.options.rootChildren) {
			this.options.document.addChild(child);
		}
		this.options.title.setInspectorHeader(undefined);
		this.restoreComposer();
		// The root viewport swap restores the conversation's own ScrollView:
		// its scroll position and follow state were never touched.
		this.options.swapViewport(undefined);
		this.options.ui.setFocus(this.options.editor);
		this.options.onInspectedChange();
		this.options.invalidate();
		this.options.requestRender();
	}

	/** The run record being inspected (for the Workbench marker). */
	private inspectedRun(): AiraChildRun | undefined {
		const runId = this.inspectedRunId;
		return runId ? this.orch()?.get(runId) : undefined;
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	private showBrowser(): void {
		this.view = "browser";
		this.browser.refresh();
		this.teardownViewSubscriptions();
		this.options.document.clear();
		this.options.document.addChild(this.browser);
		this.options.title.setInspectorHeader("AGENTS");
		this.setComposerHint(
			`${theme.fg("dim", keyText("tui.select.up"))} ${theme.fg("dim", keyText("tui.select.down"))} navigate · ${theme.fg("dim", keyText("tui.select.confirm"))} view · ${theme.fg("dim", keyText("tui.select.cancel"))} close`,
		);
		this.options.swapViewport(this.browserScrollView);
		this.browserScrollView.scrollToStart();
		this.options.ui.setFocus(this.browser);
		this.syncViewSubscriptions();
		this.options.invalidate();
		this.options.requestRender();
		this.options.onInspectedChange();
	}

	private restoreComposer(): void {
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.options.editor);
	}

	private setComposerHint(text: string): void {
		this.options.editorContainer.clear();
		const hint = new Text(theme.fg("dim", text), 0, 0, (value: string) => value);
		this.options.editorContainer.addChild(hint);
	}

	private syncViewSubscriptions(): void {
		this.teardownViewSubscriptions();
		const orch = this.orch();
		if (!orch) {
			return;
		}
		// Snapshot subscription: structural changes (dispatch/settle/eviction)
		// refresh the browser list and the transcript header. Seeded once via
		// status() so the first paint has counts without a subscribe round-trip.
		this.snapshot = orch.status();
		this.unsubscribe.push(
			orch.subscribe((status) => {
				this.snapshot = status;
				this.onOrchestrationChanged();
			}),
		);
		// Per-run event subscription: ONLY while viewing that child; removed
		// on switch/close (never duplicated, never leaked past dispose).
		const runId = this.inspectedRunId;
		if (runId) {
			this.unsubscribe.push(
				orch.subscribeEvents(runId, () => {
					this.onChildEvent();
				}),
			);
		}
		if (this.ticker === undefined) {
			this.ticker = setInterval(() => {
				this.onTick();
			}, INSPECTOR_TICK_MS);
			this.ticker.unref();
		}
	}

	private teardownViewSubscriptions(): void {
		for (const unsubscribe of this.unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// best effort
			}
		}
		this.unsubscribe = [];
	}

	private stopTicker(): void {
		if (this.ticker !== undefined) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private onOrchestrationChanged(): void {
		if (this.view === "closed") {
			return;
		}
		if (typeof this.view === "object") {
			// The viewed run may have settled or been evicted.
			if (!this.orch()?.get(this.view.runId)) {
				this.showBrowser();
				return;
			}
			this.transcript?.refresh();
		} else {
			this.browser.refresh();
		}
		this.options.invalidate();
		this.options.requestRender();
	}

	private onChildEvent(): void {
		if (typeof this.view !== "object") {
			return;
		}
		this.transcript?.refresh();
		this.options.invalidate();
		this.options.requestRender();
	}

	private onTick(): void {
		if (this.view === "closed") {
			return;
		}
		if (typeof this.view === "object") {
			this.transcript?.refresh();
		} else {
			this.browser.refresh();
		}
		this.options.requestRender();
	}

	/** Close + release everything (session teardown / mode switch). */
	dispose(): void {
		this.teardownViewSubscriptions();
		this.stopTicker();
		const wasOpen = this.view !== "closed";
		this.view = "closed";
		this.transcript = undefined;
		this.childScrollView = undefined;
		this.options.title.setInspectorHeader(undefined);
		if (wasOpen) {
			this.options.swapViewport(undefined);
		}
	}

	/** Rebind after a mode/editor change: leave the inspector cleanly. */
	rebind(): void {
		if (this.view !== "closed") {
			this.close();
		}
	}
}
