/**
 * Phase 8 — verification manager: lifecycle, smart/off/always policies,
 * trivial skips, revision dedupe, freshness/invalidation, INCONCLUSIVE
 * semantics, session dispose/cancellation.
 *
 * Deterministic: a fake agent-event emitter and a canned verifier runner.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { acquireAiraSessionState } from "../../../src/aira/state.ts";
import { AiraVerificationManager } from "../../../src/aira/verification/manager.ts";
import type { AiraVerificationSettings } from "../../../src/aira/verification/settings.ts";
import type { AiraVerifierOutcome } from "../../../src/aira/verification/verifier.ts";

function makeProjectDir(): { root: string; cleanup: () => void } {
	const root = join(tmpdir(), `aira-vm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, "src", "player.ts"), "export function seek(t: number) { return t; }\n");
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const PASS_OUTCOME: AiraVerifierOutcome = {
	ok: true,
	verdict: {
		verdict: "pass",
		summary: "All explicit requirements verified.",
		requirements: [
			{ id: "R1", text: "player stays visible after switching streams", kind: "explicit", status: "verified" },
			{ id: "R2", text: "stream switch succeeds", kind: "explicit", status: "verified" },
		],
		findings: [],
		evidence: [{ category: "execution", label: "tests", summary: "npm test exited 0" }],
		missingEvidence: [],
		scopeAssessment: { verdict: "in-scope", notes: [] },
		confidence: "high",
	},
};

const FAIL_OUTCOME: AiraVerifierOutcome = {
	ok: true,
	verdict: {
		verdict: "fail",
		summary: "Player remains black after the second switch.",
		requirements: [{ id: "R1", text: "player stays visible", kind: "explicit", status: "unmet" }],
		findings: [
			{
				severity: "blocking",
				requirementId: "R1",
				message: "player remains black after second stream switch",
				evidence: "console: TypeError: player.seek is not a function",
			},
		],
		evidence: [{ category: "browser", label: "console", summary: "TypeError: player.seek is not a function" }],
		missingEvidence: [],
		scopeAssessment: { verdict: "in-scope", notes: [] },
		confidence: "high",
	},
};

interface TestRig {
	manager: AiraVerificationManager;
	settings: AiraVerificationSettings;
	emit: (event: AgentEvent) => void;
	cwd: () => string;
	calls: () => number;
	cleanup: () => void;
}

interface RigOverrides {
	auto?: AiraVerificationSettings["auto"];
	enabled?: boolean;
	files?: Array<{
		path: string;
		status: "modified" | "added" | "deleted" | "renamed" | "untracked";
		added: number;
		deleted: number;
	}>;
	outcome?: AiraVerifierOutcome;
	mode?: "build" | "plan" | "review";
	runtimeMissing?: boolean;
	runner?: (signal?: AbortSignal) => Promise<AiraVerifierOutcome>;
}

function makeRig(overrides: RigOverrides = {}): TestRig {
	const { root, cleanup: cleanupRoot } = makeProjectDir();
	const state = acquireAiraSessionState(`sess-${Math.random().toString(36).slice(4)}`);
	state.mode = overrides.mode ?? "build";
	const settings: AiraVerificationSettings = {
		enabled: overrides.enabled ?? true,
		auto: overrides.auto ?? "smart",
		contextBudget: "compact",
	};
	const seamFiles = overrides.files ?? [{ path: "src/player.ts", status: "modified" as const, added: 3, deleted: 2 }];
	let listener: ((event: AgentEvent) => void) | undefined;
	let calls = 0;
	const outcome = overrides.outcome ?? PASS_OUTCOME;
	const manager = new AiraVerificationManager(
		state,
		(subscribe) => {
			listener = subscribe;
			return () => {
				listener = undefined;
			};
		},
		{
			cwd: root,
			settings: () => settings,
			changeSeam: async () => seamFiles,
			runtime: async () =>
				overrides.runtimeMissing
					? undefined
					: ({
							model: { id: "fake", provider: "faux" },
							streamFn: async () => {
								throw new Error("unused");
							},
						} as never),
			runner: overrides.runner
				? async (_runtime, _options, signal) => {
						calls += 1;
						return overrides.runner!(signal);
					}
				: async (_runtime, _options) => {
						calls += 1;
						return outcome;
					},
		},
	);
	manager.activate();
	return {
		manager,
		settings,
		emit: (event) => listener?.(event),
		cwd: () => root,
		calls: () => calls,
		cleanup: () => {
			void manager.dispose();
			cleanupRoot();
		},
	};
}

function userPrompt(text: string): unknown[] {
	return [
		{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
		{ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() },
	];
}

function agentEnd(
	messages: unknown[] = userPrompt("fix the player staying black after switching streams"),
): AgentEvent {
	return { type: "agent_end", messages } as AgentEvent;
}

function turnStart(): AgentEvent {
	return { type: "turn_start" } as AgentEvent;
}

function editStart(path: string): AgentEvent {
	return { type: "tool_execution_start", toolCallId: "c1", toolName: "edit", args: { path } } as AgentEvent;
}

function editEnd(toolCallId = "c1"): AgentEvent {
	return { type: "tool_execution_end", toolCallId, toolName: "edit", result: {}, isError: false } as AgentEvent;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Aira verification manager (Phase 8)", () => {
	it("publishes an idle snapshot into canonical state at arm time", () => {
		const rig = makeRig();
		try {
			expect(rig.manager.status().status).toBe("idle");
			expect(rig.manager.status().enabled).toBe(true);
			expect(rig.manager.status().auto).toBe("smart");
			expect(rig.manager.status().contextBudget).toBe("compact");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("auto-verifies a non-trivial completion at agent_end and records PASS", async () => {
		const rig = makeRig();
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(1);
			const status = rig.manager.status();
			expect(status.status).toBe("passed");
			expect(status.currentResult?.verdict).toBe("pass");
			expect(status.requirementsTotal).toBe(2);
			expect(status.requirementsVerified).toBe(2);
			expect(status.currentResult?.objective).toContain("player staying black");
			expect(status.currentResult?.revisionId).toBeTruthy();
			expect(status.stale).toBe(false);
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("does not reverify an unchanged implementation revision (dedupe)", async () => {
		const rig = makeRig();
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(1);
			const revisionId = rig.manager.status().currentResult?.revisionId;
			// A second completion boundary for the same unchanged revision: no new
			// verifier call, the current result is reported again.
			rig.emit(turnStart());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(1);
			expect(rig.manager.status().currentResult?.revisionId).toBe(revisionId);
			expect(rig.manager.status().lastSkipReason).toContain("unchanged revision");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("smart mode skips trivial work (docs) without invoking the verifier", async () => {
		const rig = makeRig({ files: [{ path: "README.md", status: "modified", added: 2, deleted: 1 }] });
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "README.md")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(0);
			expect(rig.manager.status().lastSkipReason).toContain("trivial");
			expect(rig.manager.status().status).toBe("idle");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("always mode verifies even trivial work; off mode never auto-runs", async () => {
		const always = makeRig({
			auto: "always",
			files: [{ path: "README.md", status: "modified", added: 2, deleted: 1 }],
		});
		try {
			always.emit(turnStart());
			always.emit(editStart(join(always.cwd(), "README.md")));
			always.emit(editEnd());
			always.emit(agentEnd());
			await settle();
			expect(always.calls()).toBe(1);
			always.cleanup();
		} finally {
			always.cleanup();
		}

		const off = makeRig({ auto: "off" });
		try {
			off.emit(turnStart());
			off.emit(editStart(join(off.cwd(), "src", "player.ts")));
			off.emit(editEnd());
			off.emit(agentEnd());
			await settle();
			expect(off.calls()).toBe(0);
			off.cleanup();
		} finally {
			off.cleanup();
		}
	});

	it("does not auto-verify without implementation work", async () => {
		const rig = makeRig();
		try {
			rig.emit(turnStart());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(0);
			expect(rig.manager.status().lastSkipReason).toContain("no implementation work");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("PLAN mode blocks automatic verification; explicit verify still works", async () => {
		const rig = makeRig({ mode: "plan" });
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(0);
			const explicit = await rig.manager.verify();
			expect(explicit.ok).toBe(true);
			expect(rig.calls()).toBe(1);
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("records FAIL with concrete findings and never starts a repair loop", async () => {
		const rig = makeRig({ outcome: FAIL_OUTCOME });
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			const status = rig.manager.status();
			expect(status.status).toBe("failed");
			expect(status.currentResult?.verdict).toBe("fail");
			expect(status.highestFinding?.severity).toBe("blocking");
			expect(status.highestFinding?.message).toContain("player remains black");
			// No automatic follow-up run: the same revision stays verified-once.
			rig.emit(turnStart());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(1);
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("INCONCLUSIVE verdicts are recorded as inconclusive and never become PASS", async () => {
		const rig = makeRig({
			outcome: {
				ok: true,
				verdict: {
					verdict: "inconclusive",
					summary: "Execution evidence unavailable; cannot prove behavior.",
					requirements: [{ id: "R1", text: "player stays visible", kind: "explicit", status: "unverifiable" }],
					findings: [],
					evidence: [],
					missingEvidence: ["No test/build evidence for the change"],
					scopeAssessment: { verdict: "uncertain", notes: [] },
					confidence: "low",
				},
			},
		});
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			const status = rig.manager.status();
			expect(status.status).toBe("inconclusive");
			expect(status.currentResult?.verdict).toBe("inconclusive");
			expect(status.missingEvidence).toContain("No test/build evidence for the change");
			// A repeat of the same revision still does not silently pass.
			rig.emit(turnStart());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(1);
			expect(rig.manager.status().status).toBe("inconclusive");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("verifier driver failure surfaces as INCONCLUSIVE with lastError, never PASS", async () => {
		const rig = makeRig({ runtimeMissing: true });
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			const status = rig.manager.status();
			expect(status.status).toBe("inconclusive");
			expect(status.lastError).toContain("verifier model unavailable");
			expect(status.currentResult?.verdict).not.toBe("pass");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("a new relevant edit invalidates a prior PASS immediately (stale)", async () => {
		const rig = makeRig();
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.manager.status().stale).toBe(false);
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			expect(rig.manager.status().stale).toBe(true);
			expect(rig.manager.status().currentResult?.staleReason).toContain("new edit");
			// The next agent_end re-verifies the moved revision.
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(2);
			expect(rig.manager.status().stale).toBe(false);
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("mtime drift of the verified change set stales the result on refresh", async () => {
		const rig = makeRig();
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.manager.status().stale).toBe(false);
			// Touch the verified file after completion.
			await new Promise((resolve) => setTimeout(resolve, 1100));
			writeFileSync(join(rig.cwd(), "src", "player.ts"), "export function seek(t: number) { return t + 1; }\n");
			expect(rig.manager.status().stale).toBe(true);
			expect(rig.manager.status().currentResult?.staleReason).toContain("edited after verification");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("explicit /verify reuses a current result and reruns when forced or stale", async () => {
		const rig = makeRig();
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(1);
			const reused = await rig.manager.verify();
			expect(reused.outcome).toBe("reused");
			expect(rig.calls()).toBe(1);
			const forced = await rig.manager.verify({ force: true });
			expect(forced.outcome).toBe("ran");
			expect(rig.calls()).toBe(2);
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("a changed revision during the run marks the result stale (completion fence)", async () => {
		const rig = makeRig();
		try {
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			const result = rig.manager.status().currentResult;
			expect(result?.stale).toBe(false);
			// The implementation grows: a NEW file appears on disk and the second
			// turn edits it. The change set moved → the old result is stale and the
			// new boundary re-verifies the new revision.
			writeFileSync(join(rig.cwd(), "src", "extra.ts"), "export const x = 1;\n");
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "extra.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(2);
			const fresh = rig.manager.status().currentResult;
			expect(fresh?.revisionId).not.toBe(result?.revisionId);
			expect(fresh?.stale).toBe(false);
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("disabled verification refuses explicit runs and never auto-runs", async () => {
		const rig = makeRig({ enabled: false });
		try {
			const explicit = await rig.manager.verify();
			expect(explicit.outcome).toBe("disabled");
			rig.emit(turnStart());
			rig.emit(editStart(join(rig.cwd(), "src", "player.ts")));
			rig.emit(editEnd());
			rig.emit(agentEnd());
			await settle();
			expect(rig.calls()).toBe(0);
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("dispose aborts an in-flight run and settles without a verdict", async () => {
		const rig = makeRig({
			runner: (signal) =>
				new Promise<AiraVerifierOutcome>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("verifier cancelled")), { once: true });
				}),
		});
		try {
			const run = rig.manager.verify({ force: true });
			await settle();
			expect(rig.manager.status().status).toBe("running");
			await rig.manager.dispose();
			const outcome = await run;
			expect(outcome.ok).toBe(false);
			expect(rig.manager.status().status).toBe("inconclusive");
			expect(rig.manager.status().lastError).toContain("cancelled");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("holds concurrent runs instead of duplicating them", async () => {
		const rig = makeRig();
		try {
			const first = rig.manager.verify({ force: true });
			const second = await rig.manager.verify({ force: true });
			expect(second.outcome).toBe("held");
			await first;
			expect(rig.manager.status().status).toBe("passed");
			rig.cleanup();
		} finally {
			rig.cleanup();
		}
	});

	it("per-session state isolation: two managers never share results", async () => {
		const rigA = makeRig();
		const rigB = makeRig();
		try {
			rigA.emit(turnStart());
			rigA.emit(editStart(join(rigA.cwd(), "src", "player.ts")));
			rigA.emit(editEnd());
			rigA.emit(agentEnd());
			await settle();
			expect(rigA.manager.status().status).toBe("passed");
			expect(rigB.manager.status().status).toBe("idle");
			rigA.cleanup();
			rigB.cleanup();
		} finally {
			rigA.cleanup();
			rigB.cleanup();
		}
	});
});
