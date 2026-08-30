/**
 * Phase 10 — goal lifecycle state machine: the allowed-transitions table is
 * the lifecycle contract; invalid transitions are rejected explicitly.
 */
import { describe, expect, it } from "vitest";
import {
	airaGoalTransitionError,
	assertAiraGoalTransition,
	canAiraGoalTransition,
} from "../../../src/aira/goal/state-machine.ts";
import {
	AIRA_GOAL_CLEARABLE_STATUSES,
	AIRA_GOAL_RESUMABLE_STATUSES,
	AIRA_GOAL_RUNNING_STATUSES,
	AIRA_GOAL_TERMINAL_STATUSES,
	AIRA_GOAL_TRANSITIONS,
	type AiraGoalStatus,
} from "../../../src/aira/goal/types.ts";

const ALL_STATUSES: AiraGoalStatus[] = [
	"idle",
	"active",
	"verifying",
	"repairing",
	"waiting",
	"paused",
	"completed",
	"budget-limited",
	"cancelled",
	"error",
];

describe("Aira goal state machine (Phase 10)", () => {
	it("every declared status has an explicit transition row", () => {
		for (const status of ALL_STATUSES) {
			expect(AIRA_GOAL_TRANSITIONS[status], status).toBeDefined();
		}
	});

	it("valid lifecycle transitions are accepted", () => {
		const valid: Array<[AiraGoalStatus, AiraGoalStatus]> = [
			["idle", "active"],
			["active", "verifying"],
			["active", "repairing"], // repair continuation enqueued from a deferred-active state
			["active", "waiting"],
			["active", "paused"],
			["active", "completed"],
			["active", "budget-limited"],
			["active", "cancelled"],
			["verifying", "repairing"],
			["paused", "repairing"], // resume continues a FAIL repair directly
			["verifying", "completed"],
			["verifying", "waiting"],
			["verifying", "paused"],
			["repairing", "verifying"],
			["repairing", "paused"],
			["waiting", "active"],
			["waiting", "paused"],
			["waiting", "cancelled"],
			["paused", "active"],
			["paused", "cancelled"],
			["completed", "idle"],
			["budget-limited", "idle"],
			["cancelled", "idle"],
			["error", "idle"],
		];
		for (const [from, to] of valid) {
			expect(airaGoalTransitionError(from, to), `${from} -> ${to}`).toBeUndefined();
			expect(canAiraGoalTransition(from, to)).toBe(true);
		}
	});

	it("invalid transitions are rejected with an explicit error (never silently tolerated)", () => {
		const invalid: Array<[AiraGoalStatus, AiraGoalStatus]> = [
			["idle", "completed"],
			["idle", "cancelled"],
			["idle", "budget-limited"],
			["active", "idle"],
			["repairing", "idle"],
			["completed", "active"],
			["completed", "cancelled"],
			["budget-limited", "active"],
			["cancelled", "active"],
			["error", "active"],
			["paused", "completed"],
			["idle", "idle"], // identity transitions are the manager's no-op, not a table entry
		];
		for (const [from, to] of invalid) {
			if (from === to) {
				expect(airaGoalTransitionError(from, to)).toBeUndefined();
			} else {
				const error = airaGoalTransitionError(from, to);
				expect(error, `${from} -> ${to}`).toContain(`invalid goal transition ${from} -> ${to}`);
				expect(airaGoalTransitionError(from, to, "ctx")).toContain("(ctx)");
			}
		}
		// the assert form throws
		expect(() => assertAiraGoalTransition("completed", "active", "test")).toThrow(/invalid goal transition/);
	});

	it("completion can only ever be entered from running-class states (no silent PASS path)", () => {
		for (const status of ALL_STATUSES) {
			// identity transitions are manager no-ops; otherwise completion is
			// only entered from running-class states.
			const allowed =
				status === "completed" || status === "active" || status === "verifying" || status === "repairing";
			expect(canAiraGoalTransition(status, "completed"), status).toBe(allowed);
		}
	});

	it("clear is only possible from terminal or paused states", () => {
		expect(AIRA_GOAL_CLEARABLE_STATUSES).toEqual(["completed", "budget-limited", "cancelled", "error", "paused"]);
		expect(AIRA_GOAL_TERMINAL_STATUSES).toEqual(["completed", "budget-limited", "cancelled", "error"]);
		expect(AIRA_GOAL_RUNNING_STATUSES).toEqual(["active", "repairing", "verifying"]);
		expect(AIRA_GOAL_RESUMABLE_STATUSES).toEqual(["paused", "waiting"]);
	});
});
