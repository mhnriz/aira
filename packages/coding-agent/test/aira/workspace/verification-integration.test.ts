/** Phase 13 verifier integration: evaluate the Goal-owned delta only. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { acquireAiraSessionState } from "../../../src/aira/state.ts";
import type { AiraChangeFile } from "../../../src/aira/verification/eligibility.ts";
import { AiraVerificationManager } from "../../../src/aira/verification/manager.ts";
import type { AiraVerifierOutcome } from "../../../src/aira/verification/verifier.ts";
import { createAiraWorkspaceOwnershipManager } from "../../../src/aira/workspace/ownership.ts";

const roots: string[] = [];
const PASS: AiraVerifierOutcome = {
	ok: true,
	verdict: {
		verdict: "pass",
		summary: "owned delta verified",
		requirements: [{ id: "R1", text: "owned change works", kind: "explicit", status: "verified" }],
		findings: [],
		evidence: [{ category: "repository", label: "owned", summary: "owned delta" }],
		missingEvidence: [],
		scopeAssessment: { verdict: "in-scope", notes: [] },
		confidence: "high",
	},
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "aira-verifier-ownership-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "baseline.ts"), "user work\n");
	const current = new Map<string, AiraChangeFile>([
		["src/baseline.ts", { path: "src/baseline.ts", status: "modified", added: 1, deleted: 0 }],
	]);
	const snapshot = async (): Promise<AiraChangeFile[]> => [...current.values()];
	const workspace = createAiraWorkspaceOwnershipManager({ cwd: root, snapshot });
	workspace.beginGoal();
	const state = acquireAiraSessionState(`ownership-${Math.random().toString(36).slice(2)}`);
	state.mode = "build";
	state.goal = { status: "active" } as never;
	let calls = 0;
	let envelope = "";
	const manager = new AiraVerificationManager(state, () => () => {}, {
		cwd: root,
		settings: () => ({ enabled: true, auto: "always", contextBudget: "expanded" }),
		changeSeam: snapshot,
		workspaceOwnership: workspace,
		runtime: async () => ({ model: { id: "fake", provider: "fake" } }) as never,
		runner: async (_runtime, options) => {
			calls += 1;
			envelope = options.envelope;
			return PASS;
		},
	});
	manager.activate();
	roots.push(root);
	return { root, current, workspace, state, manager, calls: () => calls, envelope: () => envelope };
}

function editEvents(path: string): [AgentEvent, AgentEvent] {
	return [
		{ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path } } as AgentEvent,
		{ type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", result: {}, isError: false } as AgentEvent,
	];
}

describe("Aira verifier workspace ownership integration", () => {
	it("does not fail or invoke the verifier for baseline dirtiness alone", async () => {
		const rig = setup();
		const result = await rig.manager.verify();
		expect(result.outcome).toBe("skipped");
		expect(result.reason).toContain("no changed files");
		expect(rig.calls()).toBe(0);
		expect(rig.manager.status().status).toBe("idle");
	});

	it("passes only Goal-owned changes and identifies protected baseline evidence", async () => {
		const rig = setup();
		writeFileSync(join(rig.root, "src", "goal.ts"), "goal work\n");
		rig.current.set("src/goal.ts", { path: "src/goal.ts", status: "modified", added: 1, deleted: 0 });
		const [start, end] = editEvents(join(rig.root, "src", "goal.ts"));
		rig.workspace.applyAgentEvent(start);
		rig.workspace.applyAgentEvent(end);
		const result = await rig.manager.verify();
		expect(result.outcome).toBe("ran");
		expect(rig.calls()).toBe(1);
		expect(rig.envelope()).toContain("baseline/pre-existing: 1");
		expect(rig.envelope()).toContain("Goal-owned: 1");
		expect(rig.envelope()).toContain("protected: 1");
		expect(readFileSync(join(rig.root, "src", "baseline.ts"), "utf8")).toBe("user work\n");
	});
});
