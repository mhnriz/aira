/**
 * Phase 8 — verification through the real AgentSession path.
 *
 * - every session arms its own verification manager and publishes the
 *   canonical snapshot;
 * - an implementation run (edit + agent_end) triggers automatic
 *   verification; the NATIVE fresh-context path is proven by scripting the
 *   verdict response into the real provider stream (`native: true`);
 * - BUILD/PLAN/REVIEW semantics: PLAN never auto-verifies, REVIEW can run
 *   explicit verification;
 * - smart trivial-skip keeps verifier tokens at zero;
 * - driver failure degrades truthfully and never breaks the session;
 * - a new edit stales a prior PASS; the next boundary re-verifies;
 * - /doctor reports verifier health without running verification;
 * - /status carries the restrained verification line.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { buildAiraDoctorReport } from "../../../src/aira/commands/doctor.ts";
import { buildAiraStatusReport } from "../../../src/aira/commands/status.ts";
import type { AiraVerifierOutcome } from "../../../src/aira/verification/verifier.ts";
import { createHarness, type Harness } from "../../suite/harness.ts";

const PASS_OUTCOME: AiraVerifierOutcome = {
	ok: true,
	verdict: {
		verdict: "pass",
		summary: "All explicit requirements verified.",
		requirements: [
			{ id: "R1", text: "player stays visible", kind: "explicit", status: "verified" },
			{ id: "R2", text: "stream switch succeeds", kind: "explicit", status: "verified" },
		],
		findings: [],
		evidence: [{ category: "execution", label: "tests", summary: "npm test exited 0" }],
		missingEvidence: [],
		scopeAssessment: { verdict: "in-scope", notes: [] },
		confidence: "high",
	},
};

const PASS_VERDICT_JSON = JSON.stringify({
	verdict: "pass",
	summary: "All explicit requirements verified.",
	requirements: [
		{ id: "R1", text: "player stays visible", kind: "explicit", status: "verified" },
		{ id: "R2", text: "stream switch succeeds", kind: "explicit", status: "verified" },
	],
	findings: [],
	evidence: [{ category: "execution", label: "tests", summary: "npm test exited 0" }],
	missingEvidence: [],
	scope: { verdict: "in-scope", notes: [] },
	confidence: "high",
});

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-suite-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "verify-proj", scripts: { test: "node test.js" } }),
	);
	writeFileSync(join(root, "src", "player.ts"), "export function seek(t: number) { return t; }\n");
	writeFileSync(join(root, "src", "player.test.ts"), "export function testSeek() { return seek(1); }\n");
	// Real git baseline: the repository change seam consumes git state, so the
	// fixture is a real repo with an initial commit (Phase 5 precedent).
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
	return root;
}

const harnesses: Array<{ harness: Harness; root: string }> = [];
afterEach(() => {
	while (harnesses.length > 0) {
		const { harness, root } = harnesses.shift()!;
		harness.session.dispose();
		harness.faux.unregister();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

async function makeVerifyHarness(
	options: {
		settings?: { auto?: "off" | "smart" | "always"; enabled?: boolean };
		mode?: "build" | "plan" | "review";
		/** Use the NATIVE verifier path (real streamFn); callers script verdict responses. */
		native?: boolean;
		/** Dirty the tracked fixture file so explicit verify() has a change to verify. */
		dirty?: boolean;
		runner?: (signal?: AbortSignal) => Promise<AiraVerifierOutcome>;
	} = {},
): Promise<Harness> {
	const root = makeProjectDir();
	if (options.dirty) {
		writeFileSync(join(root, "src", "player.ts"), "export function seek(t: number) { return t + 0; }\n");
	}
	const harness = await createHarness({
		cwd: root,
		settings: { verification: { auto: "smart", ...options.settings } } as never,
		airaVerificationOptions: options.native
			? undefined
			: {
					runner: options.runner
						? async (_runtime, _options, signal) => options.runner!(signal)
						: async () => PASS_OUTCOME,
				},
	});
	harnesses.push({ harness, root });
	if (options.mode) {
		harness.session.setAiraMode(options.mode);
	}
	return harness;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Poll until the canonical verification snapshot satisfies the predicate. */
async function waitForVerification(
	harness: Harness,
	predicate: (status: NonNullable<Harness["session"]["airaSessionState"]["verification"]>) => boolean,
	timeoutMs = 8000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = harness.session.airaSessionState.verification;
		if (status && predicate(status)) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`verification snapshot never satisfied the predicate (status ${JSON.stringify(status)?.slice(0, 600)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const EDIT_FIX = [{ oldText: "return t;", newText: "return t + 1;" }];
const EDIT_FIX2 = [{ oldText: "return t + 1;", newText: "return t + 2;" }];

const editCall = (id: string, edits: unknown[] = EDIT_FIX) => ({
	type: "toolCall" as const,
	id,
	name: "edit",
	arguments: { path: "src/player.ts", edits },
});

describe("Aira independent verification through the host (Phase 8)", () => {
	it("arms the per-session verifier and publishes the canonical snapshot", async () => {
		const harness = await makeVerifyHarness();
		expect(harness.session.airaVerification).toBeDefined();
		expect(harness.session.airaSessionState.verification).toBeDefined();
		expect(harness.session.airaSessionState.verification!.status).toBe("idle");
		expect(harness.session.airaSessionState.verification!.auto).toBe("smart");
	});

	it("auto-verifies a real implementation run at agent_end through the NATIVE verifier path", async () => {
		const harness = await makeVerifyHarness({ native: true });
		harness.setResponses([
			fauxAssistantMessage([editCall("t1")]),
			fauxAssistantMessage(fauxText("final")),
			// The fresh-context verifier consumes its own scripted verdict.
			fauxAssistantMessage(fauxText(PASS_VERDICT_JSON)),
		]);
		await harness.session.prompt("fix the player staying black after switching streams");
		await waitForVerification(harness, (status) => status.status === "passed");
		const status = harness.session.airaSessionState.verification!;
		expect(status.status).toBe("passed");
		expect(status.currentResult?.verdict).toBe("pass");
		expect(status.currentResult?.objective).toContain("player staying black");
		expect(status.requirementsVerified).toBe(2);
		expect(status.stale).toBe(false);
	});

	it("PLAN never auto-verifies; REVIEW explicit verification works", async () => {
		const planHarness = await makeVerifyHarness({ mode: "plan" });
		planHarness.setResponses([fauxAssistantMessage([editCall("t1")]), fauxAssistantMessage(fauxText("final"))]);
		await planHarness.session.prompt("fix the player staying black");
		await waitForVerification(
			planHarness,
			(status) => status.lastSkipReason !== undefined || status.status !== "idle",
		);
		expect(planHarness.session.airaSessionState.verification!.status).toBe("idle");

		const reviewHarness = await makeVerifyHarness({ mode: "review", dirty: true });
		const result = await reviewHarness.session.airaVerification!.verify();
		expect(result.ok).toBe(true);
		expect(result.outcome).toBe("ran");
		expect(reviewHarness.session.airaSessionState.verification!.status).toBe("passed");
	});

	it("smart skips trivial doc-only runs with zero verifier invocations", async () => {
		const harness = await makeVerifyHarness({ native: true });
		harness.setResponses([
			fauxAssistantMessage([
				{ type: "toolCall", id: "t1", name: "write", arguments: { path: "README.md", content: "# hi" } },
			]),
			fauxAssistantMessage(fauxText("final")),
		]);
		await harness.session.prompt("document the project");
		await waitForVerification(harness, (status) => status.lastSkipReason !== undefined);
		expect(harness.session.airaSessionState.verification!.status).toBe("idle");
		expect(harness.session.airaSessionState.verification!.lastSkipReason).toContain("trivial");
		// No verdict response was consumed: the verifier model never ran.
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("settings off disables automatic AND explicit verification", async () => {
		const harness = await makeVerifyHarness({ settings: { enabled: false } });
		const explicit = await harness.session.airaVerification!.verify();
		expect(explicit.outcome).toBe("disabled");
		harness.setResponses([fauxAssistantMessage([editCall("t1")]), fauxAssistantMessage(fauxText("final"))]);
		await harness.session.prompt("fix the player staying black");
		await settle();
		expect(harness.session.airaSessionState.verification!.status).toBe("idle");
	});

	it("driver failure degrades truthfully: INCONCLUSIVE with lastError, session keeps working", async () => {
		const harness = await makeVerifyHarness({
			runner: async () => ({ ok: false as const, driverError: "provider exploded" }),
		});
		harness.setResponses([fauxAssistantMessage([editCall("t1")]), fauxAssistantMessage(fauxText("final"))]);
		await harness.session.prompt("fix the player staying black");
		await waitForVerification(harness, (status) => status.status === "inconclusive");
		const status = harness.session.airaSessionState.verification!;
		expect(status.status).toBe("inconclusive");
		expect(status.lastError).toContain("provider exploded");
		expect(status.currentResult?.verdict).not.toBe("pass");
		// The session itself remains healthy and usable.
		expect(harness.session.airaSessionState.runtime).toBe("active");
	});

	it("a new edit stales a prior PASS; the next boundary re-verifies the moved revision", async () => {
		const harness = await makeVerifyHarness({ native: true });
		harness.setResponses([
			fauxAssistantMessage([editCall("t1")]),
			fauxAssistantMessage(fauxText("final")),
			fauxAssistantMessage(fauxText(PASS_VERDICT_JSON)),
		]);
		await harness.session.prompt("fix the player staying black");
		await waitForVerification(harness, (status) => status.status === "passed");
		const firstResultId = harness.session.airaSessionState.verification!.currentResult!.id;
		expect(harness.session.airaSessionState.verification!.stale).toBe(false);

		harness.setResponses([
			fauxAssistantMessage([editCall("t2", EDIT_FIX2)]),
			fauxAssistantMessage(fauxText("final")),
			fauxAssistantMessage(fauxText(PASS_VERDICT_JSON)),
		]);
		await harness.session.prompt("make the fix resilient");
		// Wait for a NEW result: the pre-existing PASS status alone cannot prove
		// the second boundary re-verified (it is still "passed" while stale).
		await waitForVerification(harness, (status) => (status.currentResult?.id ?? "") !== firstResultId);
		// The post-edit event invalidated the previous PASS immediately; the next
		// completion boundary re-verified the moved revision (fresh, not stale).
		const afterRun = harness.session.airaSessionState.verification!;
		expect(afterRun.currentResult?.verdict).toBe("pass");
		expect(afterRun.stale).toBe(false);
	});

	it("unchanged revision is not reverified on repeated agent_end boundaries", async () => {
		const harness = await makeVerifyHarness({ native: true });
		harness.setResponses([
			fauxAssistantMessage([editCall("t1")]),
			fauxAssistantMessage(fauxText("final")),
			fauxAssistantMessage(fauxText(PASS_VERDICT_JSON)),
		]);
		await harness.session.prompt("fix the player staying black");
		await waitForVerification(harness, (status) => status.status === "passed");
		expect(harness.session.airaSessionState.verification!.status).toBe("passed");

		// A read-only follow-up run ends without work; no new verdict response is
		// consumed (only the read-only turn's own responses are queued).
		harness.setResponses([fauxAssistantMessage(fauxText("sure"))]);
		await harness.session.prompt("thanks");
		await settle();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.airaSessionState.verification!.status).toBe("passed");
	});

	it("/doctor reports verifier health without running verification", async () => {
		const harness = await makeVerifyHarness();
		const doctor = buildAiraDoctorReport(harness.session.airaSessionState);
		const verifierCheck = doctor.checks.find((check) => check.name === "verifier");
		expect(verifierCheck).toBeDefined();
		expect(verifierCheck!.pass).toBe(true);
		expect(verifierCheck!.detail).toContain("auto smart");
		expect(verifierCheck!.detail).toContain("no result yet");
	});

	it("/status carries the restrained verification line after a verdict", async () => {
		const harness = await makeVerifyHarness({ dirty: true });
		const result = await harness.session.airaVerification!.verify();
		expect(result.ok).toBe(true);
		const report = buildAiraStatusReport(harness.session.airaSessionState);
		expect(report.verification).toBe("pass");
	});

	it("session dispose aborts an in-flight verifier run", async () => {
		const harness = await makeVerifyHarness({
			dirty: true,
			runner: (signal) =>
				new Promise<AiraVerifierOutcome>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("verifier cancelled")), { once: true });
				}),
		});
		const state = harness.session.airaSessionState;
		const run = harness.session.airaVerification!.verify({ force: true });
		await waitForVerification(harness, (status) => status.status === "running");
		harness.session.dispose();
		const outcome = await run;
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain("cancelled");
		expect(state.runtime).toBe("disposed");
	});
});
