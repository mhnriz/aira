/**
 * Aira core — native interaction modes and mode policy.
 *
 * Modes live in the canonical AiraSessionState (`state.mode`); this module is
 * the single owner of mode *semantics*: how modes cycle, what each mode is
 * for, and how the host tool policy derives from a mode. No subsystem holds a
 * second mode-state owner (ADR-005); the host reads/writes
 * `AiraSessionState.mode` only through the helpers here.
 *
 * Mode cycle: BUILD → PLAN → REVIEW → BUILD (Shift+Tab).
 *
 * Tool policy (Phase 3 scope, host/policy-level):
 * - BUILD:   full tool set; normal engineering execution subject to policy.
 * - PLAN:    genuinely read-only. The built-in mutation tools (bash,
 *            powershell, edit, write) are blocked at the agent-tool execution
 *            boundary AND hidden from the model (mode-aware availability).
 *            Reading/search/inspection tools remain available. The future
 *            planning engine is deliberately absent this phase — this module
 *            only establishes the mode and its enforcement boundary.
 * - REVIEW:  native state + basic policy semantics only. Inspection-oriented
 *            (inspect-first), still implement-capable; the independent
 *            verifier is a later phase (Phase 8), not part of this mode.
 */
import {
	BUILTIN_READ_ONLY_CAPABILITIES,
	classifyAiraBrowserOperation,
	classifyAiraCapability,
	isAiraMutatingCapability,
} from "./capabilities.ts";
import type { AiraMode, AiraSessionState } from "./state.ts";

/** The fixed three-mode order of the native cycle. */
export const AIRA_MODE_CYCLE: readonly AiraMode[] = ["build", "plan", "review"];

/** Maps each mode to its successor in the cycle: BUILD → PLAN → REVIEW → BUILD. */
export const NEXT_AIRA_MODE: Record<AiraMode, AiraMode> = {
	build: "plan",
	plan: "review",
	review: "build",
};

/**
 * Built-in read-only tools available in PLAN mode. Reading, search,
 * inspection, and other safe operations stay usable in PLAN. Phase 6 adds
 * the diagnostic process-inspection tools (they only read managed-process
 * state; they never launch or stop anything). Phase 7 adds the browser
 * observation/navigation surface — semantic page reads, evidence
 * inspection, screenshots, and read-only navigation in the isolated
 * disposable profile. Browser interaction/evaluation/verification and
 * browser lifecycle (open/close) stay PLAN-blocked (see below). Phase 9
 * adds the orchestration surface: delegation itself never mutates — the
 * orchestration scheduler IS the read-only enforcement point (PLAN
 * children receive read-only/diagnostic tool sets and mutation-capable
 * roles are refused at dispatch), so the tools stay usable in PLAN for
 * read-only exploratory children. Phase 11 adds the interaction surface:
 * `ask_user` (structured Q&A) and `tasks` (the session task graph) stay
 * usable in PLAN — they never touch the workspace or processes; asking
 * questions and planning tasks are read-only-mode activities (task rows
 * are session state, not project state; documented in the Phase 11 ADR).
 */
export const AIRA_READ_ONLY_TOOLS: readonly string[] = [
	...BUILTIN_READ_ONLY_CAPABILITIES,
	"browser_status",
	"browser_observe",
	"browser_wait",
	"browser_scroll",
	"browser_console",
	"browser_network",
	"browser_screenshot",
	"browser_navigate",
	"agents_delegate",
	"agents_status",
	"agents_cancel",
	"ask_user",
	"tasks",
];

/**
 * Built-in tools that can mutate the workspace and are therefore blocked in
 * PLAN mode. This is the host/tool-policy enforcement set. It intentionally
 * covers every built-in tool that can write or execute; read/search/inspection
 * tools are not listed. Phase 6 adds the native process runtime tools
 * (process_start/process_stop) — the semantic gate (capabilities.ts) already
 * blocks them via the `process` class; this auditable set stays in sync.
 */
export const AIRA_MUTATING_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"powershell",
	"edit",
	"write",
	"process_start",
	"process_stop",
	// PLAN-blocked browser surface: interaction/evaluation/verification and
	// browser lifecycle. The semantic gate below derives this from the
	// operation table, so this auditable set stays a documentation mirror.
	"browser_open",
	"browser_close",
	"browser_click",
	"browser_fill",
	"browser_press",
	"browser_evaluate",
	"browser_verify",
]);

/** The next mode after the given one in the cycle (pure). */
export function nextAiraMode(mode: AiraMode): AiraMode {
	return NEXT_AIRA_MODE[mode];
}

/** Advance canonical state to the next mode. Returns the new mode. */
export function cycleAiraMode(state: AiraSessionState): AiraMode {
	state.mode = nextAiraMode(state.mode);
	return state.mode;
}

/** Set canonical state to an explicit mode. Returns the new mode. */
export function setAiraMode(state: AiraSessionState, mode: AiraMode): AiraMode {
	state.mode = mode;
	return state.mode;
}

/**
 * True when the given built-in tool is blocked in PLAN: workspace-mutating
 * tools, process execution, and browser interaction/lifecycle operations
 * (semantic, table-driven). Browser observation and navigation remain
 * available in read-only mode (ADR-025).
 */
export function isAiraMutatingTool(name: string): boolean {
	if (isAiraMutatingCapability(name)) {
		return true;
	}
	// Browser tools are blocked in PLAN unless their semantic operation kind
	// is read-only-safe (observe/navigate). Purely table-driven (ADR-022).
	if (classifyAiraCapability(name) === "browser") {
		const kind = classifyAiraBrowserOperation(name);
		return kind === "interact" || kind === "lifecycle";
	}
	return false;
}

/** Human-facing label for a mode, e.g. "BUILD". */
export function airaModeLabel(mode: AiraMode): string {
	return {
		build: "BUILD",
		plan: "PLAN",
		review: "REVIEW",
	}[mode];
}

/** Single-glyph marker for a mode, e.g. "◈". */
export function airaModeGlyph(mode: AiraMode): string {
	return {
		build: "◈",
		plan: "◇",
		review: "◎",
	}[mode];
}

/** Is this mode read-only at the host/tool-policy level? */
export function isAiraModeReadOnly(mode: AiraMode): boolean {
	return mode === "plan";
}

/**
 * Small host-owned control signal appended to the model system prompt for the
 * next inference. It is advisory; tool policy remains authoritative.
 */
export function buildAiraRuntimeModeEnvelope(mode: AiraMode): string {
	const posture =
		mode === "plan"
			? "read-only; plan and inspect only"
			: mode === "review"
				? "review and gather evidence"
				: "build and verify changes";
	return `<aira-runtime mode=${airaModeLabel(mode)} posture="${posture}" host-enforcement=authoritative />`;
}

/** Build the bounded runtime control envelope, including one-shot recovery context when present. */
export function buildAiraRuntimeControlEnvelope(mode: AiraMode, recoveryHint?: string): string {
	const modeEnvelope = buildAiraRuntimeModeEnvelope(mode);
	return recoveryHint ? `${modeEnvelope}\n<aira-task-recovery>${recoveryHint}</aira-task-recovery>` : modeEnvelope;
}
