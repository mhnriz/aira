/**
 * Aira core — native capability classification contract.
 *
 * A small, semantic classification for tools/capabilities so host policy
 * (PLAN read-only, future permissions, task routing) can reason about an
 * operation without a hard-coded list of tool names alone.
 *
 * The full vocabulary is derived from the host's actual needs today:
 *
 * ```text
 * read-only    may only read the workspace / agent state (read, grep, find, ls)
 * diagnostic   reads language-server / repository-intelligence evidence; never
 *              mutates the workspace or spawns process side effects on it
 * mutating     writes the workspace (edit, write)
 * process      spawns subprocesses / executes shell (bash, powershell) —
 *              considered mutating for PLAN purposes because execution can
 *              write anywhere
 * network      performs network I/O (future: web research, api clients)
 * browser      drives a browser (future: Phase 7)
 * orchestration manages child agents (Phase 9: agents_delegate/agents_status/
 *              agents_cancel). Host-level PLAN policy does NOT block this
 *              class; the orchestration scheduler is the enforcement point
 *              (children in PLAN only receive read-only/diagnostic tool sets,
 *              and mutation-capable roles are refused at dispatch) — see
 *              orchestration/scheduler.ts.
 * unknown      a capability the host does not classify (extension tools)
 * ```
 *
 * Phase 6 extends the built-in table with the native process runtime:
 * `process_start`/`process_stop` classify as `process` (PLAN-blocked), and
 * `process_status`/`process_logs` classify as `diagnostic` (read-only
 * inspection of managed execution state, safe in PLAN).
 *
 * Phase 7 extends the table with the native browser runtime: every
 * `browser_*` tool classifies as `browser`, plus a semantic operation kind
 * (observe | navigate | interact | lifecycle) that PLAN policy consumes:
 * observation and navigation stay available in read-only mode; interaction,
 * evaluation, verification, and browser lifecycle are blocked there (see
 * modes.ts). Keep the vocabulary small: a table, not per-tool plumbing.
 *
 * Compatibility rule (ADR-020 extension): unknown/third-party tool classes are
 * NOT treated as mutating by host policy, so existing Pi extensions keep
 * working in PLAN without adopting Aira metadata. `classifyAiraCapability`
 * therefore returns `"unknown"` for anything not in the built-in table, and
 * the PLAN gate (`isAiraMutatingCapability`) only blocks known `mutating` and
 * `process` capabilities. `isAiraCapabilityReadOnly` is the wider "safe to
 * run in a read-only context" test (read-only + diagnostic).
 */
export type AiraCapabilityClass =
	| "read-only"
	| "diagnostic"
	| "mutating"
	| "process"
	| "network"
	| "browser"
	| "orchestration";

/** The built-in capability class of a tool name, or "unknown" when unclassified. */
export type AiraClassifiedCapability = AiraCapabilityClass | "unknown";

/**
 * Canonical built-in classification. Extension tools are never listed here:
 * they resolve to "unknown" by construction (see module doc).
 */
const BUILTIN_AIRA_CAPABILITY_CLASSES = {
	read: "read-only",
	grep: "read-only",
	find: "read-only",
	ls: "read-only",
	edit: "mutating",
	write: "mutating",
	bash: "process",
	powershell: "process",
	process_start: "process",
	process_stop: "process",
	process_status: "diagnostic",
	process_logs: "diagnostic",
	agents_delegate: "orchestration",
	agents_status: "orchestration",
	agents_cancel: "orchestration",
	browser_open: "browser",
	browser_close: "browser",
	browser_status: "browser",
	browser_observe: "browser",
	browser_navigate: "browser",
	browser_click: "browser",
	browser_fill: "browser",
	browser_press: "browser",
	browser_scroll: "browser",
	browser_wait: "browser",
	browser_evaluate: "browser",
	browser_console: "browser",
	browser_network: "browser",
	browser_screenshot: "browser",
	browser_verify: "browser",
} satisfies Record<string, AiraCapabilityClass>;

/** Semantic browser operation kinds (Phase 7; ADR-022 refinement). Table
 * driven like the capability classes — never tool-name heuristics.
 *
 * - observe:   read-only semantic observation / evidence inspection;
 * - navigate:  read-only navigation in the isolated profile;
 * - interact:  page interaction / evaluation / verification;
 * - lifecycle: opening and closing the browser itself. */
export type AiraBrowserOperationKind = "observe" | "navigate" | "interact" | "lifecycle";

const BUILTIN_AIRA_BROWSER_OPERATIONS = {
	browser_status: "observe",
	browser_observe: "observe",
	browser_wait: "observe",
	browser_scroll: "observe",
	browser_console: "observe",
	browser_network: "observe",
	browser_screenshot: "observe",
	browser_navigate: "navigate",
	browser_click: "interact",
	browser_fill: "interact",
	browser_press: "interact",
	browser_evaluate: "interact",
	browser_verify: "interact",
	browser_open: "lifecycle",
	browser_close: "lifecycle",
} satisfies Record<string, AiraBrowserOperationKind>;

/** Classify a tool/capability name (`"unknown"` for anything not built-in). */
export function classifyAiraCapability(name: string): AiraClassifiedCapability {
	const cls = BUILTIN_AIRA_CAPABILITY_CLASSES[name as keyof typeof BUILTIN_AIRA_CAPABILITY_CLASSES];
	return cls ?? "unknown";
}

/**
 * True when a capability never mutates the workspace and is safe in a
 * read-only context (read-only + diagnostic). Unknown capabilities are NOT
 * reported read-only here — this is the conservative truth about the class,
 * not the host policy gate (see `isAiraMutatingCapability`).
 */
export function isAiraCapabilityReadOnly(name: string): boolean {
	const cls = classifyAiraCapability(name);
	return cls === "read-only" || cls === "diagnostic";
}

/**
 * True when a capability can mutate the workspace or execute processes
 * (`mutating` + `process`). This is the PLAN enforcement predicate. Unknown
 * capabilities are deliberately NOT flagged mutating so third-party extension
 * tools remain usable in PLAN (ADR-020 documented limitation).
 */
export function isAiraMutatingCapability(name: string): boolean {
	const cls = classifyAiraCapability(name);
	return cls === "mutating" || cls === "process";
}

/** True when the capability touches the network. */
export function isAiraNetworkCapability(name: string): boolean {
	return classifyAiraCapability(name) === "network";
}

/** Human label for a capability class (doctor/reporting). */
export function airaCapabilityClassLabel(cls: AiraClassifiedCapability): string {
	const labels = {
		"read-only": "read-only",
		diagnostic: "diagnostic",
		mutating: "mutating",
		process: "process",
		network: "network",
		browser: "browser",
		orchestration: "orchestration",
		unknown: "unknown",
	} satisfies Record<AiraClassifiedCapability, string>;
	return labels[cls as keyof typeof labels] ?? "unknown";
}

/** The semantic operation kind of a browser tool ("observe" for anything not
 * classified as a browser operation). Table-driven; no name heuristics. */
export function classifyAiraBrowserOperation(name: string): AiraBrowserOperationKind {
	const kind = BUILTIN_AIRA_BROWSER_OPERATIONS[name as keyof typeof BUILTIN_AIRA_BROWSER_OPERATIONS];
	return kind ?? "observe";
}

/** Every built-in read-only tool name (source of truth for PLAN availability). */
export const BUILTIN_READ_ONLY_CAPABILITIES: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	// Diagnostic (Phase 6): managed-process inspection never mutates and is
	// safe in read-only contexts.
	"process_status",
	"process_logs",
];
