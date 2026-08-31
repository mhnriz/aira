/**
 * Aira permissions — canonical contract types.
 *
 * Phase 11: the native deterministic authorization pipeline for tool/action
 * requests. Mode enforcement (PLAN read-only) is authoritative and always
 * runs BEFORE permission policy; permission settings can never weaken PLAN.
 *
 * Permission modes (terminology fits Aira's existing mode vocabulary):
 *
 * - normal     (default) — routine engineering allowed, consequential
 *               requests ask: risky/destructive process commands, out-of-
 *               workspace writes, network-class tools, unclassified tools,
 *               browser interaction on future personal profiles. Explicit
 *               user rules apply.
 * - permissive — all normal-mode "ask" defaults auto-approve (explicit
 *               "ask" rules still prompt; explicit deny rules still deny).
 * - strict     — deny-unapproved: only read-only/diagnostic/orchestration/
 *               interaction classes and browser observation+steps stay
 *               allowed by default; everything else is denied unless an
 *               explicit rule grants allow/ask.
 * - yolo       — bypass: every "ask" auto-approves, including explicit ask
 *               rules and out-of-workspace writes. Explicit deny rules and
 *               the PLAN boundary remain absolute.
 *
 * Decision pipeline (deterministic, host-side, token-free):
 *
 *   tool/action request
 *        ↓
 *   host safety boundary (PLAN read-only — absolute, always first)
 *        ↓
 *   session "allow once" approvals (exact tool+subject, consumed)
 *        ↓
 *   explicit rules (persistent + session): most specific match wins,
 *        ties by most-recent rule
 *        ↓
 *   permission-mode defaults by capability class
 *        ↓
 *   ALLOW / ASK / DENY
 *
 * Ownership: rules live in the canonical Aira-owned config
 * (`~/.aira/agent/permissions.json`) for persistent rules and in the
 * per-session controller for session rules. Project-controlled config is
 * NEVER loaded: a repository cannot silently grant itself privileges.
 */

/** Aira permission modes (small native model; see module doc). */
export type AiraPermissionMode = "normal" | "permissive" | "strict" | "yolo";

/** Canonical pipeline outcomes. */
export type AiraPermissionAction = "allow" | "ask" | "deny";

/** Rule actions (a subset of outcomes the user may configure). */
export type AiraPermissionRuleAction = "allow" | "ask" | "deny";

/** Where a rule lives. */
export type AiraPermissionRuleScope = "session" | "persistent";

/** How a rule's subject matches. */
export type AiraPermissionRuleMatch = "exact" | "wildcard";

export interface AiraPermissionRule {
	/** Stable rule identity. */
	id: string;
	/** Exact tool name this rule applies to. */
	tool: string;
	/**
	 * Subject the rule matches:
	 * - process tools: the command string (bash/powershell/process_start);
	 * - path tools: the resolved absolute path (edit/write);
	 * - everything else: the tool name itself.
	 * "exact" rules compare literally; "wildcard" rules support `*` (any
	 * run) and `?` (any single char). Dialog approvals always create
	 * EXACT rules so an approval never broadens beyond its match.
	 */
	subject: string;
	match: AiraPermissionRuleMatch;
	action: AiraPermissionRuleAction;
	scope: AiraPermissionRuleScope;
	createdAt: number;
	/** Bounded optional note (e.g. "granted via /permissions rule add"). */
	note?: string;
}

/** The normalized input to the permission evaluator (host-side built). */
export interface AiraPermissionRequest {
	/** Tool/action name. */
	tool: string;
	/** Capability class of the tool (ADR-022 semantic table). */
	capability: string;
	/** Subject derived from tool args (command text / resolved path / name). */
	subject?: string;
	/** Browser operation kind for browser-class tools (observe/navigate/interact/lifecycle). */
	browserOperation?: string;
}

/** The deterministic evaluation outcome. */
export interface AiraPermissionEvaluation {
	action: AiraPermissionAction;
	/** Truthful human-readable reason (bounded). */
	reason: string;
	/** Matched rule id when a rule decided the outcome. */
	matchedRuleId?: string;
	/** The mode-default category that decided (when no rule matched). */
	defaultCategory?: string;
}

/** Bounded last-decision projection for the UI. */
export interface AiraPermissionLastDecision {
	tool: string;
	action: AiraPermissionAction;
	at: number;
	/** Bounded subject preview (≤ 80 chars; may be redacted). */
	subject?: string;
}

/** Rules-store health (persistent JSON under the Aira home). */
export interface AiraPermissionStoreHealth {
	status: "ok" | "unavailable" | "failed";
	/** Display path under home. */
	path: string | undefined;
	/** Bounded last failure reason. */
	error: string | undefined;
}

/** Canonical permission snapshot published into AiraSessionState.permissions. */
export interface AiraPermissionStatus {
	/** Projection of permissions.enabled (false disables the ask pipeline). */
	enabled: boolean;
	/** Projection of permissions.mode. */
	mode: AiraPermissionMode;
	/** Persistent rule count (canonical store). */
	persistentRules: number;
	/** Session rule count (incl. session approvals). */
	sessionRules: number;
	/** Pending "allow once" approvals. */
	onceApprovals: number;
	/** Persistent store health (failed never blocks the session). */
	store: AiraPermissionStoreHealth;
	/** Bounded last evaluated decision (UI hint, not a log). */
	lastDecision: AiraPermissionLastDecision | undefined;
	updatedAt: number;
	/** One-line summary for restrained surfaces. */
	summary: string;
}

export const AIRA_PERMISSION_MODES: readonly AiraPermissionMode[] = ["normal", "permissive", "strict", "yolo"];

export const AIRA_PERMISSION_RULE_ACTIONS: readonly AiraPermissionRuleAction[] = ["allow", "ask", "deny"];

export const AIRA_PERMISSION_MAX_RULES = 128;
export const AIRA_PERMISSION_MAX_SESSION_RULES = 64;
export const AIRA_PERMISSION_MAX_ONCE_APPROVALS = 64;

export const AIRA_PERMISSION_STORE_VERSION = 1;

/** Bounded persisted rules file shape (`~/.aira/agent/permissions.json`). */
export interface AiraPersistedPermissionRules {
	version: number;
	rules: Array<{
		id: string;
		tool: string;
		subject: string;
		match: AiraPermissionRuleMatch;
		action: AiraPermissionRuleAction;
		createdAt: number;
		note?: string;
	}>;
}
