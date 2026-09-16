/**
 * Phase 0.1.8 Step 1 — child structured-result reliability.
 *
 * Covers the parse-result failure path added on top of Phase 9:
 * - resilient JSON extraction from multi-object prose narration,
 * - length-aware truncation handling with one bounded continuation,
 * - bounded, privacy-safe parse diagnostics,
 * - workspace-aware task status (mutation evidence is never discarded).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { type AiraChildRuntime, parseChildResult, runAiraChild } from "../../../src/aira/orchestration/runner.ts";
import { createReadTool } from "../../../src/core/tools/read.ts";
import { createWriteTool } from "../../../src/core/tools/write.ts";

const COMPLETED_RESULT = JSON.stringify({
	status: "completed",
	summary: "Done.",
	findings: [],
	evidence: [],
	relevantFiles: [],
	changedFiles: [],
	tests: [],
	errors: [],
});

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function fauxRuntime(): { runtime: AiraChildRuntime; setResponses: (responses: unknown[]) => void } {
	const registration = registerFauxProvider({});
	registrations.push(registration);
	return {
		runtime: { model: registration.getModel(), streamFn: streamSimple, apiKey: "faux-key" },
		setResponses: (responses: unknown[]) => registration.setResponses(responses as never),
	};
}

function makeTools(cwd: string, mutable: boolean) {
	const tools = [createReadTool(cwd)];
	return mutable ? [...tools, createWriteTool(cwd)] : tools;
}

describe("parseChildResult resilience", () => {
	it("extracts the LAST balanced object from multi-object prose narration", () => {
		const text = `Here is an example shape: {"note":"ignore me"}\n\nFinal result:\n${COMPLETED_RESULT}\n`;
		expect(parseChildResult(text)).toMatchObject({ status: "completed" });
	});

	it("respects braces inside string values while balancing", () => {
		const text = 'prefix {"status":"completed","summary":"uses {curly} braces"} suffix';
		expect(parseChildResult(text)?.summary).toBe("uses {curly} braces");
	});

	it("does not fall back to an earlier example when the trailing object is truncated", () => {
		const text = 'Example: {"a":1}\nFinal: {"status":"completed","findings":["x';
		expect(parseChildResult(text)).toBeUndefined();
	});

	it("still accepts a single well-formed object wrapped in prose", () => {
		expect(parseChildResult(`before ${COMPLETED_RESULT} after`)).toMatchObject({ status: "completed" });
	});
});

describe("length-aware result recovery", () => {
	it("recovers a length-truncated result with exactly one bounded continuation", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage(fauxText('{"status":"completed","summary":"partial'), { stopReason: "length" }),
			fauxAssistantMessage(fauxText(COMPLETED_RESULT)),
		]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "child",
			tools: makeTools(root, false),
			timeoutMs: 5000,
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.result.status).toBe("completed");
		}
	});

	it("reports a distinct truncation variant with bounded diagnostics when the continuation also fails", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage(fauxText('{"status":"completed","summary":"partial'), { stopReason: "length" }),
			fauxAssistantMessage(fauxText("still not JSON"), { stopReason: "length" }),
		]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "child",
			tools: makeTools(root, false),
			timeoutMs: 5000,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		// Step 8 classification stays intact (same kind/component/operation).
		expect(outcome.error?.kind).toBe("capability_failure");
		expect(outcome.error?.component).toBe("child-protocol");
		expect(outcome.error?.operation).toBe("parse-result");
		// Truncation is now a distinguishable variant.
		expect(outcome.error?.code).toBe("child-result-truncated");
		expect(outcome.error?.message).toContain("truncated");
		const diagnostics = outcome.error?.diagnostics;
		expect(diagnostics?.stopReason).toBe("length");
		expect(diagnostics?.rawLength).toBe("still not JSON".length);
		expect(diagnostics?.rawSha256).toBe(createHash("sha256").update("still not JSON").digest("hex"));
		expect(diagnostics?.head.length).toBeLessThanOrEqual(300);
		expect(diagnostics?.tail.length).toBeLessThanOrEqual(300);
		expect(diagnostics?.workspaceMutated).toBe(false);
	});

	it("keeps the generic capability failure for non-truncated prose", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([fauxAssistantMessage(fauxText("I could not produce JSON, sorry."))]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "child",
			tools: makeTools(root, false),
			timeoutMs: 5000,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error?.code).toBeUndefined();
		expect(outcome.error?.message).toBe("child returned no valid structured result");
		expect(outcome.error?.diagnostics?.stopReason).toBe("stop");
		expect(outcome.error?.diagnostics?.rawLength).toBe("I could not produce JSON, sorry.".length);
	});
});

describe("workspace-aware task status", () => {
	it("keeps attempted status and mutation evidence when a valid write landed before the parse failure", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage([
				fauxToolCall("write", {
					path: join(root, "src", "player.ts"),
					content:
						"export function seek(t: number) { return t; }\nexport function clamp(t: number) { return t; }\n",
				}),
			]),
			fauxAssistantMessage(fauxText("Done. I updated src/player.ts.")),
		]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "child",
			tools: makeTools(root, true),
			timeoutMs: 5000,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error?.taskStatus).toBe("attempted");
		expect(outcome.error?.diagnostics?.workspaceMutated).toBe(true);
		// The engineering work is preserved on disk despite the reporting failure.
		expect(readFileSync(join(root, "src", "player.ts"), "utf8")).toContain("clamp");
	});

	it("reports not_attempted when the child never ran a tool", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([fauxAssistantMessage(fauxText("prose only, no tools"))]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "child",
			tools: makeTools(root, true),
			timeoutMs: 5000,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error?.taskStatus).toBe("not_attempted");
		expect(outcome.error?.diagnostics?.workspaceMutated).toBe(false);
	});
});
