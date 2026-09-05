/**
 * Aira orchestration — lightweight task roles.
 *
 * A small fixed role table (five roles). Roles are NOT a large agent catalog:
 * they influence prompt framing, capability-derived tool access, and the
 * expected result shape. The architecture permits additional roles later
 * without redesigning the runtime — adding a row here gives a role a
 * description, a capability set, and a tool set (derived through the
 * semantic capability tables, never tool-name string matching alone).
 *
 * Capability semantics (ADR-022 vocabulary):
 * - explore/research/review  read-only + diagnostic (never mutate);
 * - test                     adds `process` (managed test/build execution);
 * - implement                adds `mutating` + `process` (workspace writes).
 *
 * Mode gate (enforcement lives in the scheduler): in PLAN only roles whose
 * capability set is fully read-only may dispatch — implement/test are
 * REFUSED in PLAN at dispatch time, producing a truthful mode-refused error.
 * Children never receive browser tools or orchestration tools in Phase 9
 * (root-only delegation; browser capability is not granted automatically).
 */
import type { AiraChildRole } from "./types.ts";

/** Capability classes a role may use (semantic sets; tool sets derive from them). */
export type AiraRoleCapabilityClass = "read-only" | "diagnostic" | "mutating" | "process";

export interface AiraChildRoleDefinition {
	role: AiraChildRole;
	/** Human label. */
	label: string;
	/** One-line role description (prompt framing). */
	description: string;
	/** Capability classes allowed for this role (mode-gated in PLAN). */
	capabilities: readonly AiraRoleCapabilityClass[];
	/** Result-contract emphasis for the role's system prompt. */
	resultEmphasis: string;
	/** Roles that inspect but never mutate (usable in PLAN). */
	readOnly: boolean;
	/** Maximum raw tool calls for one child before exhaustion. */
	toolBudget: number;
}

/** The canonical role table (small by design; extend here, not in the runtime). */
export const AIRA_CHILD_ROLES: readonly AiraChildRoleDefinition[] = [
	{
		role: "explore",
		label: "Explore",
		description:
			"Read-only repository exploration: understand unfamiliar code, trace flows, locate definitions and usage, and report a bounded map of what exists and how it connects.",
		capabilities: ["read-only", "diagnostic"],
		resultEmphasis:
			"Prioritize concrete findings with file/line references. Relevant files are the strongest output of this role.",
		readOnly: true,
		toolBudget: 48,
	},
	{
		role: "research",
		label: "Research",
		description:
			"Read-only investigation: gather evidence from the workspace and any provided context, compare options, and report a bounded analysis with sources.",
		capabilities: ["read-only", "diagnostic"],
		resultEmphasis:
			"Prioritize a structured analysis with evidence references. Findings must name the evidence behind each claim.",
		readOnly: true,
		toolBudget: 48,
	},
	{
		role: "review",
		label: "Review",
		description:
			"Independent inspection-oriented review: read the stated files and/or changed area, evaluate correctness/robustness/fit, and report structured findings.",
		capabilities: ["read-only", "diagnostic"],
		resultEmphasis:
			"Prioritize findings ordered by severity, each with a concrete location and a suggested remediation.",
		readOnly: true,
		toolBudget: 32,
	},
	{
		role: "test",
		label: "Test",
		description:
			"Test-oriented execution and analysis: run the relevant tests/checks through the managed execution runtime, interpret results, and report what passed, what failed, and why.",
		capabilities: ["read-only", "diagnostic", "process"],
		resultEmphasis:
			"Prioritize tests/checks performed with their outcomes and the evidence (commands, exit codes, logs) behind each.",
		readOnly: false,
		toolBudget: 40,
	},
	{
		role: "implement",
		label: "Implement",
		description:
			"Bounded implementation: make the smallest coherent set of workspace changes that satisfies the task, then report what changed and what checks were performed.",
		capabilities: ["read-only", "diagnostic", "mutating", "process"],
		resultEmphasis:
			"Changed files are the strongest output of this role. Report exactly what changed, why, and which checks ran.",
		readOnly: false,
		toolBudget: 40,
	},
];

const ROLE_BY_NAME = new Map<AiraChildRole, AiraChildRoleDefinition>(AIRA_CHILD_ROLES.map((role) => [role.role, role]));

/** The role definition, or undefined for unknown role names. */
export function airaChildRoleOf(role: AiraChildRole): AiraChildRoleDefinition | undefined {
	return ROLE_BY_NAME.get(role);
}

/** True when the role is fully read-only (safe in PLAN). */
export function isAiraChildRoleReadOnly(role: AiraChildRole): boolean {
	return ROLE_BY_NAME.get(role)?.readOnly ?? false;
}

/** True when the role may mutate the workspace. */
export function isAiraChildRoleMutating(role: AiraChildRole): boolean {
	return ROLE_BY_NAME.get(role)?.capabilities.includes("mutating") ?? false;
}
