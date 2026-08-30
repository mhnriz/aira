/**
 * Aira goal — lifecycle state machine.
 *
 * Explicit transition validation: every status change goes
 * through `assertAiraGoalTransition`, which consults the table in types.ts
 * and REJECTS invalid transitions with a descriptive error instead of
 * silently tolerating them. The manager normalizes egregious external
 * requests (for example clearing an active goal) into explicit rejected
 * answers rather than corrupting state.
 */
import { AIRA_GOAL_TRANSITIONS, type AiraGoalStatus } from "./types.ts";

/**
 * Validate a lifecycle transition. Returns the error for an invalid
 * transition, or undefined when the transition is allowed. Pure — no state
 * mutation.
 */
export function airaGoalTransitionError(from: AiraGoalStatus, to: AiraGoalStatus, context = ""): string | undefined {
	if (from === to) {
		return undefined;
	}
	const allowed = AIRA_GOAL_TRANSITIONS[from] ?? [];
	if (allowed.includes(to)) {
		return undefined;
	}
	const suffix = context.length > 0 ? ` (${context})` : "";
	return `invalid goal transition ${from} -> ${to}${suffix}`;
}

/** Assert-version: throws on invalid transitions (internal invariant check). */
export function assertAiraGoalTransition(from: AiraGoalStatus, to: AiraGoalStatus, context = ""): void {
	const error = airaGoalTransitionError(from, to, context);
	if (error) {
		throw new Error(error);
	}
}

/** True when `to` is an allowed successor of `from`. */
export function canAiraGoalTransition(from: AiraGoalStatus, to: AiraGoalStatus): boolean {
	return airaGoalTransitionError(from, to) === undefined;
}

/** Human label for restrained surfaces. */
export function airaGoalStatusLabel(status: AiraGoalStatus): string {
	switch (status) {
		case "idle":
			return "idle";
		case "active":
			return "active";
		case "verifying":
			return "verifying";
		case "repairing":
			return "repairing";
		case "waiting":
			return "waiting";
		case "paused":
			return "paused";
		case "completed":
			return "completed";
		case "budget-limited":
			return "budget-limited";
		case "cancelled":
			return "cancelled";
		case "error":
			return "error";
	}
}
