/**
 * Aira UI — Workbench projection types.
 *
 * Phase 12: the Workbench is a PURE projection of canonical state. These
 * types describe what the renderer draws (panels, rows, footer segments)
 * without owning any truth. The subsystem snapshots (state.*) remain the
 * only sources; this module only DERIVES presentation from them.
 *
 * Rendering contract: projection output is theme-agnostic. Rows carry
 * semantic color roles ("copper", "red", ...) that the TUI renderer maps to
 * the active theme; the same projection renders acceptably under any
 * compatible theme (aira-zhr is only the default).
 */

import type { AiraSessionState } from "../state.ts";

/** Semantic color roles understood by the Workbench renderer (theme-agnostic). */
export type WorkbenchRole =
	| "copper" // Aira identity / active mode / primary focus
	| "copperBright" // focused border / active selection
	| "blue" // language intelligence / navigation
	| "cyan" // active agents / runtime informational
	| "green" // healthy / completed / pass
	| "yellow" // waiting / warning / idle / blocked
	| "red" // failure / blocking finding / denied
	| "purple" // model / thinking / permission/control metadata
	| "text" // ordinary state
	| "muted" // secondary metadata
	| "dim"; // tertiary metadata

/** One rendered row of a Workbench panel. */
export interface WorkbenchRow {
	/** Optional leading label column (e.g. "State", "Verdict"). */
	label?: string;
	/** Main value text. */
	value: string;
	role?: WorkbenchRole;
	/** Optional trailing value (e.g. elapsed time on task rows). */
	trailing?: string;
	trailingRole?: WorkbenchRole;
	/** Optional secondary line under the value (kept one line when possible). */
	detail?: string;
	/** Stable row key for bounded rendering (panel-scoped). */
	key?: string;
}

/** Explicit UI priority classes (Phase 12 priority model). */
export type WorkbenchPriority = 0 | 1 | 2 | 3;

/** One Workbench panel: a section in the engineering sidebar. */
export interface WorkbenchPanel {
	/** Stable panel id (used by tests and /doctor). */
	id: WorkbenchPanelId;
	/** Section title, e.g. "Working Set". */
	title: string;
	/** Explicit priority class (P0..P3). */
	priority: WorkbenchPriority;
	/** Rows to render (bounded by the projection). */
	rows: WorkbenchRow[];
	/** Optional one-line trailing hint (e.g. "waiting 18s"). */
	hint?: string;
	/** When set, the row list is capped at this many lines in medium layouts. */
	mediumCap?: number;
	/** When set, the panel is hidden entirely in medium layouts. */
	mediumHidden?: boolean;
	/** Optional progress bar (0..1) rendered under the rows. */
	progress?: {
		value: number;
		role: "green" | "red" | "yellow" | "muted";
	};
}

/** Stable panel ids (bounded enum — the Workbench shows what is relevant). */
export type WorkbenchPanelId =
	| "interaction"
	| "finding"
	| "verification"
	| "goal"
	| "tasks"
	| "agents"
	| "execution"
	| "browser"
	| "working-set"
	| "symbols"
	| "changeset"
	| "checkpoints"
	| "intelligence"
	| "control";

/** Canonical finding severity used by the footer/current-finding projection. */
export type WorkbenchFindingSeverity = "error" | "warning" | "info" | "wait";

/**
 * The single most useful current finding (arbitrated across canonical
 * sources; severity always comes from the source, never invented by the UI).
 */
export interface WorkbenchFinding {
	severity: WorkbenchFindingSeverity;
	/** Source subsystem tag, e.g. "lsp", "verifier", "browser", "goal", "ask". */
	source: string;
	/** Optional diagnostic code (e.g. "TS2339"). */
	code?: string;
	/** Compact one-line label for the footer. */
	label: string;
	/** Longer detail for the Workbench Current Finding panel. */
	detail?: string;
	/** Explicit priority class (P0 = urgent). */
	priority: WorkbenchPriority;
}

/** One footer segment with responsive drop semantics. */
export interface WorkbenchFooterSegment {
	/** Stable segment id. */
	id: WorkbenchFooterSegmentId;
	/** Rendered text (truncatable). */
	text: string;
	role?: WorkbenchRole;
	/**
	 * Drop rank: LOWER rank segments disappear FIRST when width runs out.
	 * Required segments (rank Infinity) are never dropped — only truncated.
	 */
	dropRank: number;
	/** Segments with `required: true` also get a compact variant when needed. */
	required?: boolean;
	/** Compact variant used when width is tight. */
	compact?: string;
	/** When set, truncate the segment to this many cells max. */
	maxWidth?: number;
}

/** Stable footer segment ids. */
export type WorkbenchFooterSegmentId =
	| "mode"
	| "usage"
	| "interaction"
	| "finding"
	| "lsp"
	| "verification"
	| "browser"
	| "agents"
	| "goal"
	| "execution"
	| "permission"
	| "inspector"
	| "cwd"
	| "git"
	| "context"
	| "model";

/** Layout classes the Workbench derives from terminal width. */
export type WorkbenchLayout = "wide" | "medium" | "narrow";

/** One working-set file row (from the canonical git stats seam). */
export interface WorkbenchFileRow {
	/** Path relative to the project root. */
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	added: number;
	deleted: number;
}

/** One relevant-symbol row (from the repository index). */
export interface WorkbenchSymbolRow {
	path: string;
	name: string;
	kind: string;
	line: number;
}

/** One recent local Git checkpoint, read-only and bounded for the Workbench. */
export interface WorkbenchCheckpoint {
	hash: string;
	subject: string;
	head: boolean;
	dirty: boolean;
}

/** Full Workbench projection — everything the renderer needs to draw. */
export interface WorkbenchProjection {
	/** Derived layout class for the current terminal width. */
	layout: WorkbenchLayout;
	/** Effective sidebar visibility after width + explicit-state rules. */
	sidebarVisible: boolean;
	/** Panels ordered by (priority desc, stable panel order). */
	panels: WorkbenchPanel[];
	/** Footer segments in display order (already drop-arbitrated by width). */
	footer: WorkbenchFooterSegment[];
	/** Highest-priority current finding (undefined when nothing actionable). */
	finding: WorkbenchFinding | undefined;
	/** Traffic-light summary of the finding for compact surfaces. */
	summary: string;
}

/** Inputs to the projection (all derived; never mutated by the UI). */
export interface WorkbenchProjectionInput {
	/** Canonical session state (the only source of truth). */
	state: AiraSessionState;
	/** Working-set file rows (refreshed through the coalesced canonical seam). */
	workingSet: readonly WorkbenchFileRow[];
	/** Relevant symbols from the repository index (cached, token-free). */
	symbols: readonly WorkbenchSymbolRow[];
	/** Recent local Git checkpoints (cached, read-only, token-free). */
	checkpoints: readonly WorkbenchCheckpoint[];
	/** Current terminal width in columns. */
	width: number;
	/** Workbench settings (canonical settings owner). */
	settings: {
		enabled: boolean;
		showOnStartup: boolean;
		density: "comfortable" | "compact";
		width: number;
	};
	/** Explicit user visibility choice (undefined = no explicit choice). */
	explicitVisible: boolean | undefined;
	/** Run id whose transcript the Agent Inspector is viewing (UI state only). */
	inspectedRunId?: string;
	/** Display path under home for the footer cwd segment. */
	cwd: string;
	/** Git branch for the footer cwd segment (from the cached footer seam). */
	branch: string | undefined;
	/** Context usage (canonical session context; token-free). */
	context: {
		percent: string;
		window: number;
		autoCompact: boolean;
		over90: boolean;
		over70: boolean;
	};
	/** Model label for the footer model segment. */
	modelId: string;
	/** Active thinking level, when the model supports it. */
	thinkingLevel: string | undefined;
}
