/**
 * Aira model-tool surface — deterministic capability gating for model-facing tools.
 *
 * The tool REGISTRY stays the full superset (nothing is deleted): this module
 * answers exactly one question — may the model meaningfully invoke a tool in
 * the CURRENT runtime state? The result is a filtered *model-facing* set, so
 * the fixed context cost of tool definitions tracks the capabilities the
 * session can actually use.
 *
 * Rules this module deliberately follows:
 *
 * - deterministic only: every input is a runtime capability state the host
 *   already publishes (settings gates, live subsystem snapshots). There is no
 *   prompt inspection, no keyword matching, and no probabilistic scoring;
 * - activation stays discoverable: a gated capability always keeps its
 *   activation/discovery tool visible, or keeps a read-only status tool that
 *   reports the truthful reason it cannot run;
 * - later-stage tools are the target: tools that only make sense AFTER a
 *   subsystem has been activated (an open browser session, an existing child
 *   run) are hidden until that state exists, and reappear when it does;
 * - general engineering tools are never gated: `read`, `bash`, `edit`,
 *   `write`, the code-intelligence funnel (`aira_*`), `ask_user`, `tasks`,
 *   and the native process runtime stay available in every session.
 *
 * The state is a plain value, so identical runtime state always yields the
 * identical model-facing set (`isAiraModelToolAvailable` is pure).
 */

/**
 * The deterministic runtime capability state one selection is derived from.
 *
 * Every field is already-published session truth: two settings gates that
 * decide whether a subsystem may run at all (`browser.enabled`,
 * `orchestration.enabled`) and two live runtime facts (an open Aira-owned
 * browser session, at least one child run recorded).
 */
export interface AiraModelToolCapabilityState {
	/** browser.enabled — the browser capability may run at all. */
	browserEnabled: boolean;
	/** An Aira-owned browser session is currently open (snapshot status "active"). */
	browserSessionOpen: boolean;
	/** orchestration.enabled — child delegation may run at all. */
	orchestrationEnabled: boolean;
	/** At least one child run exists (running, queued, or settled history). */
	orchestrationEstablished: boolean;
}

/**
 * Why a tool is gated.
 *
 * - `always`: general engineering capability — never gated;
 * - `browser-enabled`: the browser capability is switched off by settings, so
 *   every operation (including activation) can only fail;
 * - `browser-session`: the operation needs an open Aira-owned session; with
 *   none it raises "browser is not open" or returns empty evidence;
 * - `orchestration-enabled`: child delegation is switched off by settings;
 * - `orchestration-established`: the tool inspects/cancels existing child
 *   runs, which do not exist before the first dispatch.
 */
export type AiraModelToolGate =
	| "always"
	| "browser-enabled"
	| "browser-session"
	| "orchestration-enabled"
	| "orchestration-established";

/** The minimal orchestration snapshot shape `hasAiraOrchestrationRuns` reads. */
export interface AiraOrchestrationRunPresence {
	runningCount: number;
	queuedCount: number;
	children: readonly unknown[];
	recentResults: readonly unknown[];
	failures: readonly unknown[];
}

/**
 * Canonical gate table. Tools not listed are `always` available: extension
 * tools and the general engineering surface stay untouched.
 *
 * `browser_open` / `browser_verify` are the activation paths (verify opens a
 * session itself), so they are gated only by the capability switch, never by
 * the absence of a session. `browser_status` is the read-only discovery
 * surface and stays available so the model can always learn WHY the browser
 * capability cannot run (disabled / unavailable / idle).
 */
const BUILTIN_AIRA_MODEL_TOOL_GATES = {
	browser_open: "browser-enabled",
	browser_verify: "browser-enabled",
	browser_observe: "browser-session",
	browser_navigate: "browser-session",
	browser_click: "browser-session",
	browser_fill: "browser-session",
	browser_press: "browser-session",
	browser_scroll: "browser-session",
	browser_wait: "browser-session",
	browser_evaluate: "browser-session",
	browser_console: "browser-session",
	browser_network: "browser-session",
	browser_screenshot: "browser-session",
	browser_close: "browser-session",
	agents_delegate: "orchestration-enabled",
	agents_status: "orchestration-established",
	agents_cancel: "orchestration-established",
} satisfies Record<string, AiraModelToolGate>;

/** The gate class of a tool name (`"always"` for anything not gated). */
export function classifyAiraModelToolGate(name: string): AiraModelToolGate {
	return BUILTIN_AIRA_MODEL_TOOL_GATES[name as keyof typeof BUILTIN_AIRA_MODEL_TOOL_GATES] ?? "always";
}

/** True when the tool belongs in the model-facing set for this state. */
export function isAiraModelToolAvailable(name: string, state: AiraModelToolCapabilityState): boolean {
	switch (classifyAiraModelToolGate(name)) {
		case "always":
			return true;
		case "browser-enabled":
			return state.browserEnabled;
		case "browser-session":
			return state.browserEnabled && state.browserSessionOpen;
		case "orchestration-enabled":
			return state.orchestrationEnabled;
		case "orchestration-established":
			return state.orchestrationEnabled && state.orchestrationEstablished;
	}
}

/**
 * Whether the orchestration snapshot proves a child run exists. Any recorded
 * run counts (running, queued, settled history, or a failure record), so once
 * delegation has happened the later-stage tools stay exposed for the session.
 */
export function hasAiraOrchestrationRuns(status: AiraOrchestrationRunPresence): boolean {
	return (
		status.runningCount > 0 ||
		status.queuedCount > 0 ||
		status.children.length > 0 ||
		status.recentResults.length > 0 ||
		status.failures.length > 0
	);
}
