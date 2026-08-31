/**
 * Aira Workbench — session controller (interactive mode only).
 *
 * Owns:
 * - the sidebar's visibility state (explicit toggle vs width auto-hide);
 * - canonical subscriptions → projection refresh + render requests;
 * - coalesced working-set/symbols refreshes (never at render frequency);
 * - the regular-mode rail (overlay + width shrink) and fullscreen split;
 * - cleanup (unsubscribe everything on dispose).
 *
 * The controller holds NO subsystem truth: everything it renders comes from
 * `AiraSessionState`, the canonical handles' snapshots, and the pure
 * projection layer. Rendering consumes zero model tokens.
 */

import {
	type Component,
	Container,
	HStack,
	type OverlayHandle,
	type OverlayOptions,
	ScrollView,
	type TUI,
} from "@earendil-works/pi-tui";
import type { AiraIntelligenceHandle } from "../../../aira/intelligence/coordinator.ts";
import type { AiraSessionState } from "../../../aira/state.ts";
import { getAiraSessionState } from "../../../aira/state.ts";
import { projectWorkbench } from "../../../aira/ui/projection.ts";
import type { WorkbenchFileRow, WorkbenchProjection, WorkbenchSymbolRow } from "../../../aira/ui/types.ts";
import { workbenchSafeMinimum } from "../../../aira/ui/visibility.ts";
import type { AgentSession } from "../../../core/agent-session.ts";
import { MIN_WORKBENCH_MAIN_WIDTH, MIN_WORKBENCH_WIDTH } from "../../../core/settings-manager.ts";
import { formatCwdForFooter } from "../components/footer.ts";
import { theme as workbenchTheme } from "../theme/theme.ts";
import { AiraTuiMainScreen } from "./tui-rail.ts";
import { createWorkbenchComponent, type WorkbenchComponent } from "./workbench-component.ts";

export interface WorkbenchControllerOptions {
	session: AgentSession;
	/** Full-width footer child (regular-mode rail leaves it alone). */
	footerComponent: Component;
	/** Cached git branch (from the footer data provider — never per render). */
	getBranch: () => string | undefined;
	/** Lines the footer occupies (regular-mode rail reserves them). */
	getFooterLineCount: () => number;
	requestRender: () => void;
	invalidate: () => void;
	/** Host rebuilds the fullscreen layout root (layoutChanged). */
	layoutChanged: () => void;
}

const WORKBENCH_GIT_REFRESH_MS = 400;
/** Fullscreen scroll height cap for the unbounded sidebar content. */
const SIDEBAR_UNBOUNDED_HEIGHT = 10_000;

export class WorkbenchController {
	private readonly session: AgentSession;
	private readonly options: WorkbenchControllerOptions;
	private readonly component: WorkbenchComponent;
	private readonly container = new Container();
	private readonly sidebarScroll: ScrollView;
	private unsubscribe: Array<() => void> = [];
	private disposed = false;

	// Visibility state: explicit user choice (undefined = none yet).
	private explicitVisible: boolean | undefined;
	private sidebarWidth: number;
	private showOnStartup: boolean;
	private workbenchEnabled: boolean;
	private lastVisibleNow: boolean | undefined;

	// Cached seam inputs (refreshed coalesced, never per render).
	private workingSet: WorkbenchFileRow[] = [];
	private symbols: WorkbenchSymbolRow[] = [];
	private gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private gitRefreshVersion = 0;
	private lastChangeCount: number | undefined;

	// Renderer bindings.
	private tui: TUI | undefined;
	private regularOverlay: OverlayHandle | undefined;
	private regularOverlayOptions: OverlayOptions | undefined;

	constructor(options: WorkbenchControllerOptions) {
		this.session = options.session;
		this.options = options;
		const settings = this.session.settingsManager.getWorkbenchSettings();
		this.sidebarWidth = settings.width;
		this.showOnStartup = settings.showOnStartup;
		this.workbenchEnabled = settings.enabled;
		this.component = createWorkbenchComponent({
			getHeight: () => (this.tui?.mode === "fullscreen" ? SIDEBAR_UNBOUNDED_HEIGHT : this.railHeight()),
			showTitle: true,
			fillHeight: () => this.tui?.mode !== "fullscreen",
		});
		this.container.addChild(this.component as Component);
		this.sidebarScroll = new ScrollView(this.container, {
			follow: "none",
			primary: false,
			overscroll: "contain",
			scrollbar: this.session.settingsManager.getFullscreenScrollbar(),
			scrollbarStyle: (text) => this.scrollbarStyle(text),
		});
	}

	private scrollbarStyle(text: string): string {
		return workbenchTheme.bg("scrollbarThumb", text);
	}

	// -----------------------------------------------------------------------
	// Session state access
	// -----------------------------------------------------------------------

	private canonicalState(): AiraSessionState | undefined {
		return getAiraSessionState(this.session.sessionId);
	}

	private intelligence(): AiraIntelligenceHandle | undefined {
		return this.session.airaIntelligence;
	}

	// -----------------------------------------------------------------------
	// Visibility
	// -----------------------------------------------------------------------

	isEnabled(): boolean {
		return this.workbenchEnabled;
	}

	getExplicitVisible(): boolean | undefined {
		return this.explicitVisible;
	}

	setEnabled(enabled: boolean): void {
		this.workbenchEnabled = enabled;
		this.session.settingsManager.setWorkbenchSettings({ enabled });
		this.reconcile();
	}

	toggle(): void {
		// Visibility semantics: undefined = default-on; false = explicit off;
		// true = explicit on. First toggle from the default hides the sidebar.
		if (this.explicitVisible === false) {
			this.explicitVisible = true;
		} else {
			this.explicitVisible = false;
		}
		this.reconcile();
	}

	setVisible(visible: boolean): void {
		this.explicitVisible = visible;
		this.reconcile();
	}

	syncSettings(): void {
		const settings = this.session.settingsManager.getWorkbenchSettings();
		const widthChanged =
			settings.width !== this.sidebarWidth ||
			settings.enabled !== this.workbenchEnabled ||
			settings.showOnStartup !== this.showOnStartup;
		this.sidebarWidth = settings.width;
		this.showOnStartup = settings.showOnStartup;
		this.workbenchEnabled = settings.enabled;
		this.sidebarScroll.setScrollbar(this.session.settingsManager.getFullscreenScrollbar());
		if (widthChanged) this.options.layoutChanged();
		this.reconcile();
	}

	/** Effective visibility for a terminal width (auto-hide always wins). */
	visibleAt(width: number): boolean {
		if (!this.workbenchEnabled) return false;
		if (width < workbenchSafeMinimum(this.sidebarWidth)) return false;
		return this.explicitVisible === false ? false : this.explicitVisible === true || this.showOnStartup;
	}

	isVisibleNow(): boolean {
		return this.visibleAt(this.tui?.terminal.columns ?? 0);
	}

	/** Effective sidebar width for a terminal width (0 = hidden). */
	sidebarWidthFor(width: number): number {
		if (!this.visibleAt(width)) return 0;
		return Math.max(0, Math.min(this.sidebarWidth, Math.max(0, width - MIN_WORKBENCH_MAIN_WIDTH)));
	}

	private railHeight(): number {
		const rows = this.tui?.terminal.rows ?? 24;
		const screenLimit = Math.max(1, rows - this.options.getFooterLineCount() - 2);
		// The rail must never paint over the footer, wherever it sits in the
		// composed document (regular mode: short documents leave the footer
		// mid-screen; long ones put it at the bottom).
		if (this.tui instanceof AiraTuiMainScreen && this.tui.footerStartRow > 0) {
			return Math.max(1, Math.min(screenLimit, this.tui.footerStartRow));
		}
		return screenLimit;
	}

	// -----------------------------------------------------------------------
	// Projection (pure; token-free)
	// -----------------------------------------------------------------------

	private buildProjection(): WorkbenchProjection | undefined {
		const state = this.canonicalState();
		if (!state) return undefined;
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? this.session.state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const cwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const model = this.session.state.model;
		const thinkingLevel = this.session.state.model?.reasoning ? this.session.thinkingLevel : undefined;
		return projectWorkbench({
			state,
			workingSet: this.workingSet,
			symbols: this.symbols,
			width: this.tui?.terminal.columns ?? 0,
			settings: {
				enabled: this.workbenchEnabled,
				showOnStartup: this.showOnStartup,
				density: this.session.settingsManager.getWorkbenchSettings().density,
				width: this.sidebarWidth,
			},
			explicitVisible: this.explicitVisible,
			cwd,
			branch: this.options.getBranch(),
			context: {
				percent: contextPercent,
				window: contextWindow,
				autoCompact: this.session.autoCompactionEnabled,
				over90: contextPercentValue > 90,
				over70: contextPercentValue > 70,
			},
			modelId: model?.id ?? "no-model",
			thinkingLevel,
		});
	}

	private reconcile(): void {
		if (this.disposed) return;
		this.syncVisibility();
		const projection = this.buildProjection();
		this.component.setProjection(projection);
		this.options.invalidate();
		this.options.requestRender();
	}

	/** Rebuild layout/rail when effective visibility changed (toggle/resize). */
	private syncVisibility(): void {
		const visibleNow = this.isVisibleNow();
		if (visibleNow === this.lastVisibleNow) return;
		this.lastVisibleNow = visibleNow;
		if (this.tui instanceof AiraTuiMainScreen) {
			this.syncRegularRail();
		}
		this.options.layoutChanged();
		this.refreshOverlayWidth();
	}

	// -----------------------------------------------------------------------
	// Renderer binding
	// -----------------------------------------------------------------------

	/** Wrap the main layout root with the sidebar split (fullscreen only). */
	wrapLayout(mainRoot: Component): Component {
		if (this.tui?.mode !== "fullscreen") return mainRoot;
		const width = this.sidebarWidth;
		return new HStack([
			{
				component: mainRoot,
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: MIN_WORKBENCH_MAIN_WIDTH,
			},
			{
				component: this.sidebarScroll,
				basis: width,
				grow: 0,
				shrink: 1,
				minSize: MIN_WORKBENCH_WIDTH,
				visible: (viewport: { width: number }) => this.visibleAt(viewport.width),
			},
		]);
	}

	/** Bind to a renderer after mount (regular → rail, fullscreen → split). */
	bindTui(tui: TUI): void {
		this.tui = tui;
		if (tui instanceof AiraTuiMainScreen) {
			this.attachRegularRail(tui);
		}
		this.lastVisibleNow = undefined;
		this.reconcile();
	}

	/** Detach from the renderer (mode switch / dispose). */
	detachTui(): void {
		if (this.tui instanceof AiraTuiMainScreen) {
			this.tui.setSidebarRail({ rail: undefined, getWidth: () => 0, fullWidthChildren: [] });
		}
		this.overlayHide();
		this.tui = undefined;
		this.lastVisibleNow = undefined;
	}

	private attachRegularRail(tui: AiraTuiMainScreen): void {
		tui.setSidebarRail({
			rail: this.container,
			getWidth: () => this.sidebarWidthFor(tui.terminal.columns),
			fullWidthChildren: [this.options.footerComponent],
		});
		if (!this.regularOverlay) {
			this.regularOverlayOptions = {
				anchor: "top-right",
				width: 42,
				maxHeight: "100%",
				margin: 0,
				nonCapturing: true,
				visible: (columns: number) => this.sidebarWidthFor(columns) > 0,
			};
			this.regularOverlay = tui.showOverlay(this.container as Component, this.regularOverlayOptions);
		}
		this.refreshOverlayWidth();
	}

	private syncRegularRail(): void {
		if (!(this.tui instanceof AiraTuiMainScreen)) return;
		this.attachRegularRail(this.tui);
		this.refreshOverlayWidth();
	}

	private refreshOverlayWidth(): void {
		const columns = this.tui?.terminal.columns ?? 0;
		const width = this.sidebarWidthFor(columns);
		if (this.regularOverlayOptions) {
			this.regularOverlayOptions.width = width > 0 ? width : 42;
		}
	}

	private overlayHide(): void {
		if (this.regularOverlay) {
			try {
				this.regularOverlay.hide();
			} catch {
				// Best effort.
			}
			this.regularOverlay = undefined;
		}
	}

	// -----------------------------------------------------------------------
	// Working set / symbols refresh (coalesced canonical seam)
	// -----------------------------------------------------------------------

	/** Request a coalesced working-set refresh (never at render frequency). */
	requestWorkingSetRefresh(): void {
		if (this.gitRefreshTimer) clearTimeout(this.gitRefreshTimer);
		this.gitRefreshTimer = setTimeout(() => {
			this.gitRefreshTimer = undefined;
			void this.refreshWorkingSet();
		}, WORKBENCH_GIT_REFRESH_MS);
		this.gitRefreshTimer.unref?.();
	}

	private async refreshWorkingSet(): Promise<void> {
		const version = ++this.gitRefreshVersion;
		try {
			const intelligence = this.intelligence();
			if (!intelligence) return;
			const [stats, symbolRows] = await Promise.all([
				intelligence.workingSet().catch(() => undefined),
				Promise.resolve(intelligence.relevantSymbols(12)),
			]);
			if (this.disposed || version !== this.gitRefreshVersion) return;
			this.workingSet = (stats ?? []).map((file) => ({
				path: file.path,
				status: file.status,
				added: file.added,
				deleted: file.deleted,
			}));
			this.symbols = symbolRows.map((row) => ({ ...row }));
			this.reconcile();
		} catch {
			// Best effort: the Workbench must never break the session.
		}
	}

	private onIntelligenceChanged(): void {
		const state = this.canonicalState();
		const changeCount = state?.intelligence?.repository.changeCount;
		if (changeCount !== this.lastChangeCount) {
			this.lastChangeCount = changeCount;
			this.requestWorkingSetRefresh();
		}
		this.reconcile();
	}

	// -----------------------------------------------------------------------
	// Subscriptions (canonical seams; token-free; cleaned up on dispose)
	// -----------------------------------------------------------------------

	attach(): void {
		const session = this.session;
		const unsubscribe: Array<() => void> = [];
		const subscribe = (fn: (listener: () => void) => () => void): void => {
			unsubscribe.push(fn(() => this.onCanonicalChanged()));
		};
		subscribe((listener) => {
			const handle = session.airaIntelligence;
			return handle ? handle.subscribe(listener) : () => {};
		});
		subscribe((listener) => {
			const handle = session.airaExecution;
			return handle ? handle.subscribe(listener) : () => {};
		});
		subscribe((listener) => {
			const handle = session.airaBrowser;
			return handle ? handle.subscribe(listener) : () => {};
		});
		subscribe((listener) => {
			const handle = session.airaVerification;
			return handle ? handle.subscribe(listener) : () => {};
		});
		subscribe((listener) => {
			const handle = session.airaOrchestration;
			return handle ? handle.subscribe(listener) : () => {};
		});
		subscribe((listener) => {
			const handle = session.airaGoal;
			return handle ? handle.subscribe(listener) : () => {};
		});
		subscribe((listener) => {
			const handle = session.airaInteraction;
			return handle ? handle.subscribe(listener) : () => {};
		});
		subscribe((listener) => {
			const handle = session.airaPermissions;
			return handle ? handle.subscribe(listener) : () => {};
		});
		subscribe((listener) => {
			const handle = session.airaTasks;
			return handle ? handle.subscribe(listener) : () => {};
		});
		unsubscribe.push(session.subscribe(() => this.onAgentEvent()));
		this.unsubscribe = unsubscribe;
		this.lastChangeCount = this.canonicalState()?.intelligence?.repository.changeCount;
		this.requestWorkingSetRefresh();
		this.reconcile();
	}

	private onCanonicalChanged(): void {
		this.onIntelligenceChanged();
	}

	private onAgentEvent(): void {
		// Tool executions and stream ticks change context/working-set truth.
		this.onCanonicalChanged();
	}

	/** Live subscription count (doctor diagnostics). */
	subscriptionCount(): number {
		return this.unsubscribe.length;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// Best effort.
			}
		}
		this.unsubscribe = [];
		if (this.gitRefreshTimer) clearTimeout(this.gitRefreshTimer);
		this.gitRefreshTimer = undefined;
		this.detachTui();
	}
}
