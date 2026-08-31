/**
 * Aira interaction — canonical structured Q&A contract types.
 *
 * Phase 11: the native structured user-question primitive. One
 * `AiraInteractionManager` per session owns the pending/answered interaction
 * state; the permission controller (kind "permission") and the model-facing
 * `ask_user` tool (kind "semantic") share the SAME interaction
 * infrastructure. The full conversation is never copied into a second Q&A
 * store — only a bounded machine-readable pending interaction is held here,
 * plus a tiny bounded history of closed interactions for the UI.
 *
 * Lifecycle: pending → resolved (answered | cancelled | timed-out |
 * unavailable | superseded). At most ONE pending interaction exists per
 * session (nested interaction storms are impossible by construction).
 * Session shutdown resolves any pending interaction truthfully as
 * unavailable/cancelled — never a wedged session.
 */

/** What kind of decision the interaction asks for (authorization vs product). */
export type AiraInteractionType = "permission" | "semantic";

/** How a pending interaction resolved. */
export type AiraInteractionResolution = "answered" | "cancelled" | "timed-out" | "unavailable" | "superseded";

/** One selectable choice in a structured question. */
export interface AiraInteractionChoice {
	/** Stable machine-readable choice id (bounded). */
	id: string;
	/** Short display label (bounded). */
	label: string;
	/** Optional longer explanation (bounded). */
	description?: string;
}

/** A bounded structured question (what the model/host may request). */
export interface AiraInteractionRequest {
	/** "permission" = tool authorization; "semantic" = product/user decision. */
	type: AiraInteractionType;
	/** The question text (bounded, required). */
	question: string;
	/** Short context/reason shown before the question (bounded, optional). */
	context?: string;
	/** Structured choices (single-select unless multiSelect). */
	choices?: AiraInteractionChoice[];
	/** Allow multiple selections (typed subset accepted by the dialog). */
	multiSelect?: boolean;
	/** Allow a freeform typed answer. */
	freeform?: boolean;
	/** Bounded owner tag ("permission:bash", "agent", "goal", ...). */
	owner?: string;
	/** Optional auto-timeout in milliseconds (0/undefined = no timeout). */
	timeoutMs?: number;
}

/** The answer delivered to the caller of `ask()`. */
export interface AiraInteractionAnswer {
	interactionId: string;
	type: AiraInteractionType;
	resolution: AiraInteractionResolution;
	/** Selected choice ids ("answered" only). */
	selections: string[];
	/** Freeform text ("answered" only). */
	text?: string;
	/** Permission decision when type === "permission" (allow-once | allow-session | allow-always | deny). */
	decision?: "allow-once" | "allow-session" | "allow-always" | "deny";
}

/** Bounded pending-interaction projection (token-free, UI-ready). */
export interface AiraInteractionPendingProjection {
	interactionId: string;
	type: AiraInteractionType;
	/** Bounded question summary (≤ 200 chars). */
	prompt: string;
	/** Bounded context/reason (≤ 400 chars; UI-only, never model context). */
	context?: string;
	/** Bounded structured choices (≤ 12; UI-only, never model context). */
	choices: ReadonlyArray<Pick<AiraInteractionChoice, "id" | "label"> & { description?: string }>;
	/** Number of structured choices offered. */
	choicesCount: number;
	multiSelect: boolean;
	freeform: boolean;
	/** Owner tag ("permission:bash", "agent", ...). */
	owner: string | undefined;
	/** When the interaction started waiting. */
	waitingSince: number;
	/** Elapsed waiting duration in milliseconds (live-derived). */
	durationMs: number;
}

/** Bounded closed-interaction row for the UI (most recent first). */
export interface AiraInteractionClosedProjection {
	interactionId: string;
	type: AiraInteractionType;
	/** Bounded question summary (≤ 200 chars). */
	prompt: string;
	resolution: AiraInteractionResolution;
	closedAt: number;
}

/** Canonical interaction snapshot published into AiraSessionState.interaction. */
export interface AiraInteractionStatus {
	/** True when a question is open and awaiting a user answer. */
	pending: boolean;
	/** The pending question projection (undefined when idle). */
	question: AiraInteractionPendingProjection | undefined;
	/** Bounded recent closed-interaction history (≤ 4 rows). */
	recentClosed: AiraInteractionClosedProjection[];
	/** True when an interactive UI bridge is attached (dialog can render). */
	uiAttached: boolean;
	/** True when the last snapshot write failed gracefully (never throws). */
	updatedAt: number;
	/** One-line summary for restrained surfaces. */
	summary: string;
}
