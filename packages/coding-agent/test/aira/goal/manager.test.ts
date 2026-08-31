/**
 * Phase 10 — goal manager: lifecycle, SMART promotion, PASS/FAIL/
 * INCONCLUSIVE flows, bounded continuation (rounds, budgets, no-progress,
 * repeated verdict), stop/resume/cancel/clear, user steering, ownership
 * isolation, session dispose, stale completion, PLAN safety, projection
 * truthfulness.
 *
 * Deterministic: a fake verification handle publishes canned results into
 * canonical state (the goal consumes state.verification exactly like the
 * real runtime), a fake execution handle records evidence acquisition, and
 * a temp-dir persistence store records recovery semantics.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { type AiraGoalHandle, createAiraGoalManager } from "../../../src/aira/goal/manager.ts";
import { createAiraGoalPersistence } from "../../../src/aira/goal/persistence.ts";
import type { AiraGoalSettings } from "../../../src/aira/goal/settings.ts";
import { type AiraSessionState, acquireAiraSessionState } from "../../../src/aira/state.ts";
import type { AiraVerificationHandle } from "../../../src/aira/verification/manager.ts";
import type { AiraVerificationResult, AiraVerificationStatus } from "../../../src/aira/verification/types.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface VerdictTemplate {
	verdict: "pass" | "fail" | "inconclusive";
	summary?: string;
	blocking?: Array<{ message: string; evidence?: string }>;
	requirements?: Array<{ id: string; text: string; status: "verified" | "unmet" | "unverifiable" }>;
	missingEvidence?: string[];
	evidence?: Array<{ category: string; label: string; summary: string }>;
	tokenUsage?: { total: number };
	revisionId?: string;
}

function resultOf(template: VerdictTemplate, index: number, revisionId: string): AiraVerificationResult {
	return {
		id: `v-${index}`,
		revisionId: template.revisionId ?? revisionId,
		verdict: template.verdict,
		summary: template.summary ?? `summary-${index}`,
		mode: "build",
		objective: "objective",
		requirements: (template.requirements ?? []).map((requirement) => ({
			...requirement,
			kind: "explicit" as const,
		})),
		findings: (template.blocking ?? []).map((finding) => ({
			severity: "blocking" as const,
			message: finding.message,
			...(finding.evidence ? { evidence: finding.evidence } : {}),
		})),
		evidence: (template.evidence ?? []).map((item) => ({
			category: item.category as AiraVerificationResult["evidence"][number]["category"],
			label: item.label,
			summary: item.summary,
		})),
		missingEvidence: template.missingEvidence ?? [],
		scopeAssessment: { verdict: "in-scope", notes: [] },
		confidence: "high",
		...(template.tokenUsage
			? {
					tokenUsage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: template.tokenUsage.total,
					},
				}
			: {}),
		startedAt: 1_000,
		completedAt: 2_000,
		stale: false,
	};
}

type AiraVerifyOutcome = "ran" | "reused" | "skipped" | "held" | "disabled" | "refused" | "failed";

type UsageSnapshot = {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
};

class FakeVerification implements AiraVerificationHandle {
	private state: AiraSessionState;
	readonly outcomes: VerdictTemplate[];
	calls = 0;
	enabled = true;
	auto: "off" | "smart" | "always" = "smart";
	explicit = false;

	constructor(state: AiraSessionState, outcomes: VerdictTemplate[]) {
		this.state = state;
		this.outcomes = outcomes;
		this.publishIdle();
	}

	private publishIdle(): void {
		this.state.verification = {
			status: "idle",
			enabled: this.enabled,
			auto: this.auto,
			contextBudget: "compact",
			requirementsTotal: 0,
			requirementsVerified: 0,
			stale: false,
			missingEvidence: [],
			updatedAt: Date.now(),
		};
	}

	async verify(): Promise<{
		ok: boolean;
		outcome: AiraVerifyOutcome;
		result?: AiraVerificationResult;
		reason?: string;
	}> {
		this.calls += 1;
		if (this.explicit) {
			// explicit path (verification.auto=off): only a manually published
			// result can exist; verify() does nothing.
			return { ok: false, outcome: "off" as AiraVerifyOutcome, reason: "verification.auto=off" };
		}
		const template = this.outcomes[this.calls - 1];
		if (!template) {
			return { ok: false, outcome: "failed", reason: "no canned outcome" };
		}
		const result = resultOf(template, this.calls, `rev-${this.calls}`);
		this.state.verification = {
			...this.state.verification!,
			status: result.verdict === "pass" ? "passed" : result.verdict === "fail" ? "failed" : "inconclusive",
			currentResult: result,
			requirementsTotal: result.requirements.length,
			requirementsVerified: result.requirements.filter((r) => r.status === "verified").length,
			missingEvidence: result.missingEvidence,
			completedAt: Date.now(),
		};
		return { ok: true, outcome: "ran", result };
	}

	/** Manually publish a result (explicit /verify path). */
	publish(template: VerdictTemplate, revisionId: string): void {
		const result = resultOf(template, 100 + this.calls, revisionId);
		this.state.verification = {
			...this.state.verification!,
			status: result.verdict === "pass" ? "passed" : result.verdict === "fail" ? "failed" : "inconclusive",
			currentResult: result,
			requirementsTotal: result.requirements.length,
			requirementsVerified: result.requirements.filter((r) => r.status === "verified").length,
			missingEvidence: result.missingEvidence,
			completedAt: Date.now(),
		};
	}

	status(): AiraVerificationStatus {
		return this.state.verification!;
	}

	subscribe(): () => void {
		return () => undefined;
	}

	applyAgentEvent(): void | Promise<void> {
		return undefined;
	}

	async dispose(): Promise<void> {
		return undefined;
	}
}

interface RigOptions {
	settings?: Partial<AiraGoalSettings>;
	outcomes?: VerdictTemplate[];
	startReason?: string;
	sessionId?: string;
	usageBaseline?: UsageSnapshot;
	hasPendingMessages?: () => boolean;
	continuations?: boolean;
	projectTestCommands?: string[];
	now?: () => number;
	persistDir?: string;
}

interface Rig {
	manager: AiraGoalHandle;
	state: AiraSessionState;
	verification: FakeVerification;
	settings: AiraGoalSettings;
	emit: (event: AgentEvent) => void;
	settle: () => Promise<void>;
	continuationTexts: string[];
	aborts: { count: number };
	executionStarts: Array<{ command: string }>;
	usage: UsageSnapshot;
	cleanup: () => void;
}

function makeRig(options: RigOptions = {}): Rig {
	const root = join(tmpdir(), `aira-goal-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	const state = acquireAiraSessionState(options.sessionId ?? `g-${Math.random().toString(36).slice(6)}`);
	const settings: AiraGoalSettings = {
		enabled: true,
		auto: "smart",
		maxRounds: 4,
		tokenBudget: undefined,
		maxDurationMs: undefined,
		...options.settings,
	};
	state.project = {
		root,
		languages: ["TypeScript"],
		testCommands: options.projectTestCommands ?? [],
		checkCommands: [],
	} as never;
	const verification = new FakeVerification(state, options.outcomes ?? []);
	const usage: UsageSnapshot = options.usageBaseline ?? {
		tokens: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1_500 },
		cost: 0.01,
	};
	const continuationTexts: string[] = [];
	const aborts = { count: 0 };
	const executionStarts: Array<{ command: string }> = [];
	let listener: ((event: AgentEvent) => void | Promise<void>) | undefined;
	const baseDir = options.persistDir ?? join(root, "persist");
	const persistence = createAiraGoalPersistence(state.sessionId, options.startReason ?? "startup", { baseDir });
	const manager = createAiraGoalManager(state, {
		cwd: root,
		sessionId: state.sessionId,
		startReason: options.startReason ?? "startup",
		settings: () => settings,
		verification,
		execution: {
			start: async (request) => {
				executionStarts.push({ command: request.command ?? "" });
				return { ok: true, status: "exited", exitCode: 0 };
			},
		},
		usageSeam: () => ({ tokens: usage.tokens, cost: usage.cost }),
		hasPendingMessages: options.hasPendingMessages,
		sendContinuation:
			options.continuations === false
				? undefined
				: async (text) => {
						continuationTexts.push(text);
						return true;
					},
		abortRun: () => {
			aborts.count += 1;
		},
		persistence,
		...(options.now ? { now: options.now } : {}),
		agentEvents: (subscribe) => {
			listener = subscribe;
			return () => {
				listener = undefined;
			};
		},
	});
	return {
		manager,
		state,
		verification,
		settings,
		emit: (event) => void listener?.(event),
		settle: async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		continuationTexts,
		aborts,
		executionStarts,
		usage,
		cleanup: () => {
			void manager.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function userMessageStart(text: string): AgentEvent {
	return {
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	} as AgentEvent;
}

function agentEnd(messages: unknown[] = [], willRetry = false): AgentEvent {
	return {
		type: "agent_end",
		messages:
			messages.length > 0
				? messages
				: [
						{ role: "user", content: [{ type: "text", text: "implement auth" }], timestamp: Date.now() },
						{ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() },
					],
		...(willRetry ? { willRetry: true } : {}),
	} as AgentEvent;
}

function abortedEnd(): AgentEvent {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: "x" }], timestamp: Date.now() },
			{ role: "assistant", content: [], stopReason: "aborted", timestamp: Date.now() },
		],
	} as AgentEvent;
}

function runEndedWithError(): AgentEvent {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: "x" }], timestamp: Date.now() },
			{
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "provider exploded",
				timestamp: Date.now(),
			},
		],
	} as AgentEvent;
}

const PASS_TEMPLATE: VerdictTemplate = {
	verdict: "pass",
	summary: "All explicit requirements verified.",
	requirements: [{ id: "R1", text: "auth works", status: "verified" }],
	evidence: [{ category: "execution", label: "tests", summary: "npm test exited 0" }],
	tokenUsage: { total: 4_000 },
};
const FAIL_TEMPLATE: VerdictTemplate = {
	verdict: "fail",
	summary: "Auth middleware rejects valid tokens.",
	requirements: [{ id: "R1", text: "auth works", status: "unmet" }],
	blocking: [{ message: "valid tokens are rejected with 401", evidence: "test: auth.test.js:12" }],
};

// ---------------------------------------------------------------------------
// lifecycle + promotion
// ---------------------------------------------------------------------------

describe("Aira goal manager (Phase 10) — lifecycle and promotion", () => {
	it("publishes an idle snapshot into canonical state at arm time", () => {
		const rig = makeRig();
		try {
			const status = rig.manager.status();
			expect(status.status).toBe("idle");
			expect(status.id).toBeUndefined();
			expect(status.enabled).toBe(true);
			expect(status.auto).toBe("smart");
			expect(status.maxRounds).toBe(4);
			expect(rig.state.goal?.status).toBe("idle");
		} finally {
			rig.cleanup();
		}
	});

	it("SMART promotion: non-trivial objective creates a goal; trivial skips with zero overhead", () => {
		const rig = makeRig();
		try {
			rig.emit(userMessageStart("fix the typo in the header"));
			expect(rig.manager.status().status).toBe("idle");
			expect(rig.state.goal?.status).toBe("idle");

			rig.emit(userMessageStart("implement authentication middleware for the API"));
			expect(rig.manager.status().status).toBe("active");
			expect(rig.manager.status().objective).toContain("authentication");
			expect(rig.manager.status().round).toBe(1);
			expect(rig.manager.status().id).toBeTruthy();
		} finally {
			rig.cleanup();
		}
	});

	it("manual /goal create is explicit intent (no SMART gate); disabled goals refuse", () => {
		const rig = makeRig();
		try {
			const result = rig.manager.create("implement auth");
			expect(result.ok).toBe(true);
			expect(rig.manager.status().status).toBe("active");
			expect(rig.manager.create("second goal").ok).toBe(false);
		} finally {
			rig.cleanup();
		}
		const rig2 = makeRig({ settings: { enabled: false } });
		try {
			expect(rig2.manager.create("implement auth").ok).toBe(false);
			// automatic promotion also refuses
			rig2.emit(userMessageStart("implement authentication middleware for the API"));
			expect(rig2.manager.status().status).toBe("idle");
		} finally {
			rig2.cleanup();
		}
	});

	it("a new objective replaces a terminal goal; running goals refuse a new /goal create", async () => {
		const rig = makeRig({ outcomes: [PASS_TEMPLATE] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("completed");
			expect(rig.manager.create("another feature").ok).toBe(true);
			expect(rig.manager.status().objective).toContain("another feature");
			expect(rig.manager.create("third").ok).toBe(false);
		} finally {
			rig.cleanup();
		}
	});

	it("stop preserves state and allows resume; clear removes terminal state safely", async () => {
		const rig = makeRig({ settings: { maxRounds: 2 } });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			await rig.settle();
			expect(rig.manager.stop().ok).toBe(true);
			expect(rig.manager.status().status).toBe("paused");
			expect(rig.manager.status().stopReason).toBe("user");
			expect(rig.aborts.count).toBe(1); // owned in-flight work was aborted
			expect(rig.manager.stop().ok).toBe(false); // already paused
			// state preserved across resume
			expect(rig.manager.resume().ok).toBe(true);
			expect(rig.manager.status().status).toBe("active");
			// clear refuses while active
			expect(rig.manager.clear().ok).toBe(false);
			rig.manager.stop();
			expect(rig.manager.clear().ok).toBe(true);
			expect(rig.manager.status().status).toBe("idle");
		} finally {
			rig.cleanup();
		}
	});

	it("cancel terminates an active goal and propagates to owned work; clear removes it", () => {
		const rig = makeRig();
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			expect(rig.manager.cancel().ok).toBe(true);
			expect(rig.manager.status().status).toBe("cancelled");
			expect(rig.aborts.count).toBe(1);
			expect(rig.manager.resume().ok).toBe(false);
			expect(rig.manager.clear().ok).toBe(true);
			expect(rig.manager.status().status).toBe("idle");
		} finally {
			rig.cleanup();
		}
	});

	it("session dispose persists an active goal as paused (interrupted) — never auto-resume", async () => {
		const rig = makeRig();
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			await rig.manager.dispose();
			const reloaded = createAiraGoalPersistence(rig.state.sessionId, "startup", {
				baseDir: join(rig.state.project?.root ?? "", "persist"),
			}).recover();
			expect(reloaded?.status).toBe("paused");
			expect(reloaded?.stopReason).toBe("interrupted");
			expect(reloaded?.objective).toContain("authentication");
		} finally {
			rig.cleanup();
		}
	});

	it("unrelated sessions never inherit an active goal (ownership isolation)", () => {
		const rig = makeRig();
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			expect(rig.manager.status().status).toBe("active");
			// a second session over a DIFFERENT session id with the same
			// persistence dir stays idle
			const other = makeRig({ sessionId: `${rig.state.sessionId}-other`, startReason: "startup" });
			try {
				expect(other.manager.status().status).toBe("idle");
				expect(other.state.goal?.status).toBe("idle");
			} finally {
				other.cleanup();
			}
		} finally {
			rig.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// verdict flows
// ---------------------------------------------------------------------------

describe("Aira goal manager (Phase 10) — PASS / FAIL / INCONCLUSIVE", () => {
	it("PASS completes the goal with the verdict summary; no continuation fires", async () => {
		const rig = makeRig({ outcomes: [PASS_TEMPLATE] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("completed");
			expect(status.completedAt).toBeTruthy();
			expect(status.verification.verdict).toBe("pass");
			expect(status.verification.summary).toContain("All explicit requirements");
			expect(status.staleCompletion).toBe(false);
			expect(rig.continuationTexts).toEqual([]);
			expect(rig.verification.calls).toBe(1);
		} finally {
			rig.cleanup();
		}
	});

	it("FAIL drives a bounded repair continuation with a compact directive (never the conversation)", async () => {
		const rig = makeRig({ outcomes: [FAIL_TEMPLATE] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("repairing");
			expect(status.round).toBe(2);
			expect(status.stopReason).toBeUndefined();
			expect(rig.continuationTexts).toHaveLength(1);
			const directive = rig.continuationTexts[0]!;
			expect(directive).toContain("AUTONOMOUS GOAL CONTINUATION");
			expect(directive).toContain("valid tokens are rejected with 401");
			expect(directive).not.toContain("implement authentication middleware\n\nuser:");
		} finally {
			rig.cleanup();
		}
	});

	it("FAIL → repair round ends → fresh verification PASS → completed (repair loop works)", async () => {
		const rig = makeRig({ outcomes: [FAIL_TEMPLATE, PASS_TEMPLATE] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("repairing");
			expect(rig.manager.status().round).toBe(2);
			// the repair round ends (new revision verified by the canned PASS)
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("completed");
			expect(status.round).toBe(2);
			expect(rig.verification.calls).toBe(2);
			expect(rig.continuationTexts).toHaveLength(1);
		} finally {
			rig.cleanup();
		}
	});

	it("max rounds bounds continuation: FAIL at the maximum round becomes budget-limited", async () => {
		// the second FAIL has a DIFFERENT blocker: the stop must come from
		// the round bound, not repeated-verdict detection
		const rig = makeRig({
			settings: { maxRounds: 2 },
			outcomes: [FAIL_TEMPLATE, { ...FAIL_TEMPLATE, blocking: [{ message: "a different blocker" }] }],
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("repairing");
			expect(rig.manager.status().round).toBe(2);
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("budget-limited");
			expect(status.stopReason).toBe("max-rounds");
			expect(rig.continuationTexts).toHaveLength(1); // no round 3
		} finally {
			rig.cleanup();
		}
	});

	it("no-progress detection: identical revision + identical blocker across rounds stops continuation", async () => {
		const rig = makeRig({ outcomes: [FAIL_TEMPLATE, { ...FAIL_TEMPLATE, revisionId: "rev-1" }] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("repairing");
			// the repair round ends WITHOUT changing the implementation state
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("budget-limited");
			expect(status.stopReason).toBe("no-progress");
			expect(rig.continuationTexts).toHaveLength(1);
		} finally {
			rig.cleanup();
		}
	});

	it("repeated-verdict detection: identical FAIL verdict twice stops continuation", async () => {
		const sameFail = { ...FAIL_TEMPLATE };
		const rig = makeRig({ settings: { maxRounds: 4 }, outcomes: [sameFail, sameFail] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			// second FAIL with the same blocking finding — even though the
			// revision moved (not no-progress), the identical verdict stops.
			expect(status.status).toBe("budget-limited");
			expect(status.stopReason).toBe("repeated-verdict");
			expect(rig.continuationTexts).toHaveLength(1);
		} finally {
			rig.cleanup();
		}
	});

	it("no-progress is distinct from progress: a changed blocker continues repair", async () => {
		const rig = makeRig({ settings: { maxRounds: 4 }, outcomes: [FAIL_TEMPLATE] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("repairing");
			// round 2 FAILs with a DIFFERENT blocker: the implementation state
			// moved (new revision, new finding) — that is progress, so repair
			// continues within bounds.
			rig.state.verification!.currentResult = undefined;
			rig.verification.publish(
				{ ...FAIL_TEMPLATE, blocking: [{ message: "session tokens are not refreshed" }] },
				"rev-2",
			);
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("repairing");
			expect(status.round).toBe(3);
			expect(rig.continuationTexts).toHaveLength(2);
		} finally {
			rig.cleanup();
		}
	});

	it("INCONCLUSIVE with safely acquirable evidence runs bounded tests then reverifies", async () => {
		const rig = makeRig({
			projectTestCommands: ["npm test"],
			outcomes: [
				{ verdict: "inconclusive", summary: "tests not run", missingEvidence: ["tests were not run"] },
				PASS_TEMPLATE,
			],
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("completed");
			expect(rig.executionStarts).toEqual([{ command: "npm test" }]); // Phase 6 runtime reused
			expect(rig.verification.calls).toBe(2); // initial + forced re-verify
		} finally {
			rig.cleanup();
		}
	});

	it("INCONCLUSIVE that stays unresolved enters truthful waiting (never a silent PASS)", async () => {
		const rig = makeRig({
			projectTestCommands: ["npm test"],
			outcomes: [
				{
					verdict: "inconclusive",
					summary: "still incomplete",
					missingEvidence: ["tests were not run", "browser behavior unverified"],
				},
				{ verdict: "inconclusive", summary: "still incomplete", missingEvidence: ["browser behavior unverified"] },
			],
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("waiting");
			expect(status.stopReason).toBe("missing-evidence");
			expect(status.needsUserInput).toBe(true);
			expect(status.waiting?.detail).toContain("could not be fully acquired");
			expect(rig.executionStarts.length).toBe(1); // acquisition attempted once
			expect(status.verification.verdict).toBe("inconclusive");
		} finally {
			rig.cleanup();
		}
	});

	it("INCONCLUSIVE requiring a user choice enters waiting with a structured ask seam", async () => {
		const rig = makeRig({
			outcomes: [
				{
					verdict: "inconclusive",
					summary: "ambiguous",
					missingEvidence: ["choose between the two authentication approaches"],
				},
			],
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("waiting");
			expect(status.stopReason).toBe("input-required");
			expect(status.waiting?.ask).toContain("two authentication approaches");
			expect(status.waiting?.reason).toBe("input-required");
		} finally {
			rig.cleanup();
		}
	});

	it("browser-class missing evidence never forces browser use (waits truthfully)", async () => {
		const rig = makeRig({
			outcomes: [{ verdict: "inconclusive", missingEvidence: ["browser behavior needs verification"] }],
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("waiting");
			expect(rig.executionStarts).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});

	it("verifier driver failure (no result at all) stops continuation without a loop", async () => {
		const rig = makeRig({ outcomes: [] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("active");
			expect(status.lastEvent).toContain("no fresh verification verdict");
			expect(rig.continuationTexts).toEqual([]);
			// the session stays fully usable
			const result = rig.manager.create("a different objective");
			expect(result.ok).toBe(false); // still active — truthful
		} finally {
			rig.cleanup();
		}
	});

	it("verification.auto=off: no automatic verifier call at boundaries; an explicit result completes", async () => {
		const rig = makeRig({ outcomes: [] });
		try {
			rig.state.verification!.auto = "off";
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.verification.calls).toBe(0);
			expect(rig.manager.status().status).toBe("active");
			expect(rig.continuationTexts).toEqual([]);
			// the user runs explicit /verify — the goal consumes that verdict
			rig.verification.publish(PASS_TEMPLATE, "rev-x");
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("completed");
		} finally {
			rig.cleanup();
		}
	});

	it("verification disabled: completion cannot be established; no continuation, host stays usable", async () => {
		const rig = makeRig();
		try {
			rig.state.verification!.enabled = false;
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("active");
			expect(status.lastEvent).toContain("verification disabled");
			expect(rig.verification.calls).toBe(0);
		} finally {
			rig.cleanup();
		}
	});

	it("PLAN is genuinely read-only: no verification, no continuation at boundaries", async () => {
		const rig = makeRig({ outcomes: [PASS_TEMPLATE] });
		try {
			rig.state.mode = "plan";
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("active");
			expect(status.mode).toBe("plan");
			expect(rig.verification.calls).toBe(0);
			expect(rig.continuationTexts).toEqual([]);
			// switching to build allows the boundary to proceed normally
			rig.state.mode = "build";
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("completed");
		} finally {
			rig.cleanup();
		}
	});

	it("an aborted run pauses (interrupted); a run error pauses (agent-error)", async () => {
		const rig = makeRig();
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(abortedEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("paused");
			expect(rig.manager.status().stopReason).toBe("interrupted");

			rig.manager.resume();
			rig.emit(runEndedWithError());
			await rig.settle();
			expect(rig.manager.status().status).toBe("paused");
			expect(rig.manager.status().stopReason).toBe("agent-error");
		} finally {
			rig.cleanup();
		}
	});

	it("a willRetry agent_end is not a completed round (host retry semantics)", async () => {
		const rig = makeRig({ outcomes: [] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd([], true));
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("active");
			expect(rig.verification.calls).toBe(0);
		} finally {
			rig.cleanup();
		}
	});

	it("user steering: pending user messages defer the repair continuation", async () => {
		const pending = { value: false };
		const rig = makeRig({ outcomes: [FAIL_TEMPLATE, PASS_TEMPLATE], hasPendingMessages: () => pending.value });
		try {
			pending.value = true;
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("active"); // deferred, never stuck
			expect(status.lastEvent).toContain("deferred");
			expect(rig.continuationTexts).toEqual([]);
			// the queued user turn runs as the next round and produces a fresh
			// verdict (new revision) — the boundary then proceeds normally
			pending.value = false;
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("completed");
			expect(rig.continuationTexts).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});

	it("a user message during an active goal is steering, never a second goal", () => {
		const rig = makeRig();
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			const id = rig.manager.status().id;
			rig.emit(userMessageStart("add a constraint: JWT only"));
			expect(rig.manager.status().id).toBe(id);
			expect(rig.manager.status().status).toBe("active");
			expect(rig.manager.status().lastEvent).toContain("steering");
		} finally {
			rig.cleanup();
		}
	});

	it("a user message resumes a paused/waiting goal", async () => {
		const rig = makeRig({
			outcomes: [{ verdict: "inconclusive", missingEvidence: ["choose between the two approaches"] }],
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("waiting");
			rig.emit(userMessageStart("use JWT"));
			expect(rig.manager.status().status).toBe("active");
			expect(rig.manager.status().waiting).toBeUndefined();
		} finally {
			rig.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// budgets / usage / freshness
// ---------------------------------------------------------------------------

describe("Aira goal manager (Phase 10) — budgets, usage, freshness", () => {
	it("token budget exhaustion stops continuation truthfully (no further model calls)", async () => {
		const rig = makeRig({
			settings: { tokenBudget: 2_000 },
			outcomes: [FAIL_TEMPLATE],
			usageBaseline: { tokens: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1_500 }, cost: 0 },
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			// the implementation round consumed 3k tokens since the baseline
			rig.usage.tokens = { input: 3_000, output: 1_500, cacheRead: 0, cacheWrite: 0, total: 4_500 };
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("budget-limited");
			expect(status.stopReason).toBe("token-budget");
			expect(status.usage.consumedTokens).toBe(3_000);
			expect(status.usage.remainingTokens).toBe(0);
			expect(rig.continuationTexts).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});

	it("duration budget exhaustion stops continuation with a truthful reason", async () => {
		let clock = 10_000;
		const rig = makeRig({
			settings: { maxDurationMs: 60_000 },
			outcomes: [FAIL_TEMPLATE],
			now: () => clock,
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			expect(rig.manager.status().startedAt).toBe(10_000);
			// 5 minutes pass before the round ends
			clock = 10_000 + 300_000;
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("budget-limited");
			expect(status.stopReason).toBe("max-duration");
			expect(rig.continuationTexts).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});

	it("usage aggregates session + children + verifier tokens truthfully", async () => {
		const rig = makeRig({
			outcomes: [
				{ ...FAIL_TEMPLATE, tokenUsage: { total: 3_000 } },
				{ ...PASS_TEMPLATE, tokenUsage: { total: 4_000 } },
			],
			usageBaseline: {
				tokens: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1_500 },
				cost: 0.01,
			},
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			// children produce 2800 tokens during round 1 (after the goal
			// started, so the promotion baseline cannot pre-absorb them)
			rig.state.orchestration = {
				aggregateTokenUsage: { input: 2_000, output: 800, cacheRead: 0, cacheWrite: 0, total: 2_800 },
			} as never;
			rig.usage.tokens = { input: 3_000, output: 1_000, cacheRead: 0, cacheWrite: 0, total: 4_000 };
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("repairing");
			expect(status.usage.sessionTokens).toBe(2_500);
			expect(status.usage.childrenTokens).toBe(2_800);
			expect(status.usage.verifierTokens).toBe(3_000); // FAIL run usage
			expect(status.usage.consumedTokens).toBe(2_500 + 2_800 + 3_000);
			expect(status.usage.sources).toEqual(["session", "children", "verifier"]);
			// second round: children add 500 more; verifier tokens accumulate
			rig.state.orchestration = {
				aggregateTokenUsage: { input: 2_400, output: 900, cacheRead: 0, cacheWrite: 0, total: 3_300 },
			} as never;
			rig.emit(agentEnd());
			await rig.settle();
			const after = rig.manager.status();
			expect(after.status).toBe("completed");
			expect(after.usage.verifierTokens).toBe(7_000);
			// cumulative child tokens: 2800 (round 1) + 500 (round 2)
			expect(after.usage.childrenTokens).toBe(3_300);
		} finally {
			rig.cleanup();
		}
	});

	it("stale completion is represented truthfully after the verified revision moves", async () => {
		const rig = makeRig({ outcomes: [PASS_TEMPLATE] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().staleCompletion).toBe(false);
			// a later edit stales the verification (Phase 8 semantics)
			rig.state.verification!.currentResult!.stale = true;
			rig.state.verification!.stale = true;
			const status = rig.manager.status();
			expect(status.status).toBe("completed");
			expect(status.staleCompletion).toBe(true);
			expect(status.verification.stale).toBe(true);
			expect(status.summary).toContain("stale");
		} finally {
			rig.cleanup();
		}
	});

	it("revision projection exposes the verified revision and round", async () => {
		const rig = makeRig({ outcomes: [PASS_TEMPLATE] });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.revision?.revisionId).toBe("rev-1");
			expect(status.revision?.round).toBe(1);
		} finally {
			rig.cleanup();
		}
	});

	it("task-graph projection comes from the canonical orchestration snapshot (no second owner)", async () => {
		const rig = makeRig();
		try {
			rig.state.orchestration = {
				runningCount: 1,
				queuedCount: 1,
				children: [
					{ id: "c1", phase: "running" },
					{ id: "c2", phase: "waiting-capacity" },
					{ id: "c3", phase: "settled" },
				],
			} as never;
			rig.emit(userMessageStart("implement authentication middleware"));
			const status = rig.manager.status();
			expect(status.tasks.active).toBe(2);
			expect(status.tasks.completed).toBe(1);
			expect(status.summary).toContain("1/3 tasks");
		} finally {
			rig.cleanup();
		}
	});

	it("resume after a FAIL-driven pause continues the repair within the same bounds", async () => {
		const rig = makeRig({
			settings: { maxRounds: 3 },
			outcomes: [FAIL_TEMPLATE, { ...FAIL_TEMPLATE, blocking: [{ message: "a different blocker" }] }],
		});
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			expect(rig.manager.status().status).toBe("repairing");
			expect(rig.manager.status().round).toBe(2);
			rig.manager.stop();
			rig.manager.resume();
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("repairing");
			expect(status.round).toBe(3);
			expect(rig.continuationTexts).toHaveLength(2);
			// bounds still hold: a FAIL at round 3 (max 3) cannot open round 4
			rig.emit(agentEnd());
			await rig.settle();
			const finalStatus = rig.manager.status();
			expect(finalStatus.status).toBe("budget-limited");
			expect(finalStatus.stopReason).toBe("max-rounds");
		} finally {
			rig.cleanup();
		}
	});

	it("no continuation seam (headless hosts) halts truthfully and awaits a user turn", async () => {
		const rig = makeRig({ outcomes: [FAIL_TEMPLATE], continuations: false });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			rig.emit(agentEnd());
			await rig.settle();
			const status = rig.manager.status();
			expect(status.status).toBe("active");
			expect(status.lastEvent).toContain("no continuation seam");
			expect(rig.executionStarts).toEqual([]);
		} finally {
			rig.cleanup();
		}
	});

	it("resume of a recovered (interrupted) goal with FAIL context continues bounded repair", async () => {
		const rig = makeRig({ settings: { maxRounds: 3 } });
		try {
			rig.emit(userMessageStart("implement authentication middleware"));
			const goalId = rig.manager.status().id;
			await rig.manager.dispose();
			// restart over the same session id AND the same persistence store
			const reloaded = makeRig({
				sessionId: rig.state.sessionId,
				startReason: "resume",
				persistDir: join(rig.state.project?.root ?? "", "persist"),
			});
			try {
				const status = reloaded.manager.status();
				expect(status.status).toBe("paused");
				expect(status.stopReason).toBe("interrupted");
				expect(status.id).toBe(goalId);
				expect(reloaded.manager.resume().ok).toBe(true);
				expect(reloaded.manager.status().status).toBe("active");
			} finally {
				reloaded.cleanup();
			}
		} finally {
			rig.cleanup();
		}
	});
});
