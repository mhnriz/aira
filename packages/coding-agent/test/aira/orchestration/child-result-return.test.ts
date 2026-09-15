/**
 * 0.1.7 Step 10 — the parent model consumes the child's structured result.
 *
 * Measured before this change on 20 archived completed child runs: only the
 * summary line reached the parent model (13.9% of the produced result bytes);
 * findings/relevantFiles/tests/errors stayed in `details`, which packages/ai
 * never reads, so they were never provider-visible.
 *
 * These tests pin the parent-facing projection: deterministic, bounded,
 * no ceremony for tiny results, evidence stays UI-only, and every Step 8
 * failure envelope keeps its classification.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../suite/harness.ts";

const harnesses: Array<{ harness: Harness; root: string }> = [];

afterEach(() => {
	for (const { harness, root } of harnesses.splice(0)) {
		harness.session.dispose();
		harness.faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-child-return-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "player.ts"), "export function seek(t: number) { return t; }\n");
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}

async function makeHarness(): Promise<Harness> {
	const root = makeProjectDir();
	const harness = await createHarness({ cwd: root, settings: { orchestration: { enabled: true } } as never });
	harnesses.push({ harness, root });
	return harness;
}

const delegateCall = (id: string, tasks: unknown[]) => ({
	type: "toolCall" as const,
	id,
	name: "agents_delegate",
	arguments: { tasks, await: true },
});

const childResult = (result: Record<string, unknown>) => JSON.stringify(result);

/** The parent-visible payload of the last agents_delegate tool result. */
function delegateResultText(harness: Harness): string {
	const messages = harness.session.messages as Array<{
		role?: string;
		toolName?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "toolResult" || message.toolName !== "agents_delegate") continue;
		return (message.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
	}
	throw new Error("no agents_delegate tool result in the session transcript");
}

/** Child task ids are generated per run; normalize them for assertions. */
function normalizeTaskIds(text: string): string {
	return text.replace(/- \S+ \((\w+)\):/g, "- ($1):");
}

async function waitForSettled(harness: Harness): Promise<void> {
	const deadline = Date.now() + 8000;
	for (;;) {
		const status = harness.session.airaSessionState.orchestration;
		const children = status?.children ?? [];
		if (children.length > 0 && children.every((child) => child.status !== "running" && child.status !== "pending")) {
			return;
		}
		if (Date.now() > deadline) throw new Error("orchestration did not settle");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function runDelegation(result: Record<string, unknown>): Promise<string> {
	const harness = await makeHarness();
	harness.setResponses([
		fauxAssistantMessage([delegateCall("t1", [{ role: "explore", task: "map src/player.ts" }])]),
		fauxAssistantMessage(fauxText(childResult(result))),
		fauxAssistantMessage(fauxText("done")),
	]);
	await harness.session.prompt("delegate exploration");
	await waitForSettled(harness);
	return delegateResultText(harness);
}

describe("child result return", () => {
	it("returns the child's findings, files, and validation to the parent model", async () => {
		const text = await runDelegation({
			status: "completed",
			summary: "seek is a no-op",
			findings: ["[High] seek never clamps negative values (src/player.ts:1)", "[Info] no tests cover seek"],
			evidence: ["src/player.ts:1"],
			relevantFiles: ["src/player.ts"],
			changedFiles: [],
			tests: ["vitest run test/player.test.ts — 3 passed"],
			errors: [],
		});
		expect(text).toContain("(explore): completed: seek is a no-op");
		expect(text).toContain("findings:");
		expect(text).toContain("[High] seek never clamps negative values (src/player.ts:1)");
		expect(text).toContain("[Info] no tests cover seek");
		expect(text).toContain("files:");
		expect(text).toContain("src/player.ts");
		expect(text).toContain("validation:");
		expect(text).toContain("3 passed");
	});

	it("does not leak evidence into the model-facing result", async () => {
		const text = await runDelegation({
			status: "completed",
			summary: "checked the player module",
			findings: [],
			evidence: ["src/player.ts:1-3 (no-op clamp)", "src/player.ts:7"],
			relevantFiles: ["src/player.ts"],
			changedFiles: [],
			tests: [],
			errors: [],
		});
		expect(text).not.toContain("evidence:");
		expect(text).not.toContain("no-op clamp");
	});

	it("adds no ceremony for a tiny child result", async () => {
		const text = await runDelegation({
			status: "completed",
			summary: "nothing to report",
			findings: [],
			evidence: [],
			relevantFiles: [],
			changedFiles: [],
			tests: [],
			errors: [],
		});
		expect(normalizeTaskIds(text)).toBe("dispatched 1 task(s)\n- (explore): completed: nothing to report");
	});

	it("renders errors even when the child reports completed", async () => {
		const text = await runDelegation({
			status: "completed",
			summary: "partial mapping",
			findings: ["[Low] naming drift in src/player.ts"],
			evidence: [],
			relevantFiles: [],
			changedFiles: [],
			tests: [],
			errors: ["read of src/audio.ts failed: ENOENT"],
		});
		expect(text).toContain("errors:");
		expect(text).toContain("read of src/audio.ts failed: ENOENT");
	});

	it("bounds findings deterministically and marks the remainder", async () => {
		const findings = Array.from({ length: 12 }, (_, i) => `finding number ${i + 1}`);
		const text = await runDelegation({
			status: "completed",
			summary: "many findings",
			findings,
			evidence: [],
			relevantFiles: [],
			changedFiles: [],
			tests: [],
			errors: [],
		});
		expect(text).toContain("finding number 8");
		expect(text).not.toContain("finding number 9");
		expect(text).toContain("+4 more (full result in UI details)");
	});

	it("clips a single oversized item and stays deterministic", async () => {
		const long = "x".repeat(400);
		const first = await runDelegation({
			status: "completed",
			summary: "long finding",
			findings: [long],
			evidence: [],
			relevantFiles: [],
			changedFiles: [],
			tests: [],
			errors: [],
		});
		const second = await runDelegation({
			status: "completed",
			summary: "long finding",
			findings: [long],
			evidence: [],
			relevantFiles: [],
			changedFiles: [],
			tests: [],
			errors: [],
		});
		expect(normalizeTaskIds(first)).toBe(normalizeTaskIds(second));
		expect(first).toContain("…");
		expect(first).not.toContain(long);
	});
});

describe("child failure return", () => {
	it("keeps the task_failure classification and returns the preserved findings", async () => {
		const text = await runDelegation({
			status: "failed",
			summary: "could not finish the mapping",
			findings: ["[Blocker] src/player.ts imports a module that does not exist"],
			evidence: [],
			relevantFiles: ["src/player.ts"],
			changedFiles: [],
			tests: [],
			errors: ["ENOENT: src/audio.ts"],
		});
		expect(text).toContain("CHILD_TASK_FAILURE [driver]");
		expect(text).toContain("component child-run · operation acceptance · task_status attempted");
		expect(text).toContain("could not finish the mapping");
		expect(text).toContain("[Blocker] src/player.ts imports a module that does not exist");
		expect(text).toContain("ENOENT: src/audio.ts");
	});

	it("leaves a child with no structured result unchanged", async () => {
		const text = await runDelegation({ status: "failed", summary: "" });
		expect(text).toContain("CHILD_TASK_FAILURE [driver]");
		expect(text).not.toContain("findings:");
		expect(text).not.toContain("files:");
	});
});
