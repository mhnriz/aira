/**
 * Phase 8 — the fresh-context verifier runner: structured verdict parsing,
 * read-only tool loop, hardening rules, provider-failure behavior.
 *
 * Deterministic: the faux provider serves scripted assistant messages; the
 * verifier's restricted read-only tools execute against real fixture files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AiraVerifierRuntime,
	normalizeVerifierVerdict,
	parseVerifierVerdict,
	runAiraVerifier,
} from "../../../src/aira/verification/verifier.ts";

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-verifier-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "player.ts"), "export function seek(t: number) { return t; }\n");
	return root;
}

const registrations: Array<{ unregister: () => void }> = [];
afterEach(() => {
	while (registrations.length > 0) {
		registrations.shift()?.unregister();
	}
});

function fauxRuntime(): {
	runtime: AiraVerifierRuntime;
	setResponses: (responses: Parameters<typeof registerFauxProvider> extends never ? never : unknown[]) => void;
} {
	const registration = registerFauxProvider({});
	registrations.push(registration);
	const model = registration.getModel();
	return {
		runtime: { model, streamFn: streamSimple, apiKey: "faux-key" },
		setResponses: (responses: unknown[]) => registration.setResponses(responses as never),
	};
}

const PASS_VERDICT = JSON.stringify({
	verdict: "pass",
	summary: "All requirements verified",
	requirements: [
		{ id: "R1", text: "player stays visible after switching streams", kind: "explicit", status: "verified" },
		{ id: "R2", text: "stream switch succeeds", kind: "inferred", status: "verified" },
	],
	findings: [],
	evidence: [{ category: "execution", label: "test", summary: "npm test exited 0" }],
	missingEvidence: [],
	scope: { verdict: "in-scope", notes: [] },
	confidence: "high",
});

describe("Aira fresh-context verifier runner (Phase 8)", () => {
	it("runs a tool round and returns the structured PASS verdict", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/player.ts" })]),
			fauxAssistantMessage(fauxText(PASS_VERDICT)),
		]);
		const outcome = await runAiraVerifier(runtime, { cwd: root, envelope: "OBJECTIVE\nfix player", timeoutMs: 5000 });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.verdict.verdict).toBe("pass");
			expect(outcome.verdict.requirements).toHaveLength(2);
			expect(outcome.verdict.requirements[0].kind).toBe("explicit");
			expect(outcome.verdict.requirements[1].kind).toBe("inferred");
			expect(outcome.verdict.scopeAssessment.verdict).toBe("in-scope");
		}
	});

	it("binds the tool loop: read tools execute against the real filesystem", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage([
				fauxToolCall("read", { path: "src/player.ts" }),
				fauxToolCall("grep", { pattern: "seek", path: "src" }),
			]),
			fauxAssistantMessage(fauxText(PASS_VERDICT)),
		]);
		const outcome = await runAiraVerifier(runtime, { cwd: root, envelope: "x", timeoutMs: 5000 });
		expect(outcome.ok).toBe(true);
	});

	it("accepts fenced JSON and fails closed on unparseable output", async () => {
		expect(parseVerifierVerdict(`\`\`\`json\n${PASS_VERDICT}\n\`\`\``)).toBeDefined();
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([fauxAssistantMessage(fauxText("the verdict is pass because reasons"))]);
		const outcome = await runAiraVerifier(runtime, { cwd: root, envelope: "x", timeoutMs: 5000 });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("no valid structured verdict");
		}
	});

	it("hardens pass-with-unmet into FAIL", () => {
		const verdict = normalizeVerifierVerdict(
			JSON.parse(
				JSON.stringify({
					verdict: "pass",
					summary: "looks done",
					requirements: [
						{ id: "R1", text: "a", kind: "explicit", status: "verified" },
						{ id: "R2", text: "b", kind: "explicit", status: "unmet" },
					],
					findings: [],
					evidence: [{ category: "execution", label: "t", summary: "ok" }],
					missingEvidence: [],
					scope: { verdict: "in-scope", notes: [] },
					confidence: "high",
				}),
			),
		);
		expect(verdict.verdict).toBe("fail");
		expect(verdict.summary).toContain("unmet");
	});

	it("hardens pass-without-concrete-evidence into INCONCLUSIVE", () => {
		const verdict = normalizeVerifierVerdict(
			JSON.parse(
				JSON.stringify({
					verdict: "pass",
					summary: "trust me",
					requirements: [{ id: "R1", text: "a", kind: "explicit", status: "verified" }],
					findings: [],
					evidence: [],
					missingEvidence: [],
					scope: { verdict: "uncertain", notes: [] },
					confidence: "low",
				}),
			),
		);
		expect(verdict.verdict).toBe("inconclusive");
		expect(verdict.summary).toContain("INCONCLUSIVE");
	});

	it("treats malformed verdicts as INCONCLUSIVE, never PASS", () => {
		const verdict = normalizeVerifierVerdict({ verdict: "banana", summary: "" });
		expect(verdict.verdict).toBe("inconclusive");
		const noVerdict = normalizeVerifierVerdict({});
		expect(noVerdict.verdict).toBe("inconclusive");
	});

	it("maps provider errors to a driver error (never a verdict)", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage(fauxText("boom"), { stopReason: "error", errorMessage: "provider exploded" }),
		]);
		const outcome = await runAiraVerifier(runtime, { cwd: root, envelope: "x", timeoutMs: 5000 });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("provider exploded");
		}
	});

	it("fails closed when the model keeps calling tools beyond the budget", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })]),
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })]),
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })]),
		]);
		const outcome = await runAiraVerifier(runtime, { cwd: root, envelope: "x", timeoutMs: 5000, maxToolRounds: 2 });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("tool budget");
		}
	});

	it("cancellation settles as a driver error", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		// A hanging verifier response: the run must settle on abort, not hang.
		setResponses([() => new Promise(() => {}) as never]);
		const controller = new AbortController();
		const run = runAiraVerifier(runtime, { cwd: root, envelope: "x", timeoutMs: 60_000 }, controller.signal);
		controller.abort();
		const outcome = await run;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("cancelled");
		}
	});
});
