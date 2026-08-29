/**
 * Phase 9 — orchestration roles and capability derivation: a small fixed
 * table with read-only vs mutating semantics. No large agent catalog.
 */
import { describe, expect, it } from "vitest";
import {
	AIRA_CHILD_ROLES,
	airaChildRoleOf,
	isAiraChildRoleMutating,
	isAiraChildRoleReadOnly,
} from "../../../src/aira/orchestration/roles.ts";

describe("Aira orchestration roles (Phase 9)", () => {
	it("keeps the taxonomy small and fixed", () => {
		expect(AIRA_CHILD_ROLES.map((role) => role.role).sort()).toEqual([
			"explore",
			"implement",
			"research",
			"review",
			"test",
		]);
	});

	it("explore/research/review are read-only; test/implement can mutate", () => {
		for (const role of ["explore", "research", "review"] as const) {
			expect(isAiraChildRoleReadOnly(role)).toBe(true);
			expect(isAiraChildRoleMutating(role)).toBe(false);
		}
		expect(isAiraChildRoleReadOnly("test")).toBe(false);
		expect(isAiraChildRoleMutating("test")).toBe(false); // process only, no workspace writes
		expect(isAiraChildRoleMutating("implement")).toBe(true);
	});

	it("each role carries framing, capabilities, and result emphasis", () => {
		for (const role of AIRA_CHILD_ROLES) {
			expect(role.label.length).toBeGreaterThan(0);
			expect(role.description.length).toBeGreaterThan(20);
			expect(role.capabilities.length).toBeGreaterThan(0);
			expect(role.resultEmphasis.length).toBeGreaterThan(10);
		}
		const test = airaChildRoleOf("test")!;
		expect(test.capabilities).toContain("process");
		const implement = airaChildRoleOf("implement")!;
		expect(implement.capabilities).toContain("mutating");
	});

	it("unknown roles resolve to undefined (no silent generic fallback)", () => {
		expect(airaChildRoleOf("scout" as never)).toBeUndefined();
	});
});
