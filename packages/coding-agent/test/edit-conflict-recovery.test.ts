import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionTelemetry } from "../src/core/session-telemetry.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { applyEditsWithRecovery, type Edit } from "../src/core/tools/edit-diff.ts";
import { planStaleRegionRecovery } from "../src/core/tools/edit-recovery.ts";

const readFileAsBuffer = (path: string): Promise<Buffer> => readFile(path);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-recovery-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

const STALE_FILE = [
	"function calculateTotal(items) {",
	"  // Keep calculation centralized.",
	"  const total = items.reduce((sum, item) => sum + item, 0);",
	"  return total;",
	"}",
	"",
].join("\n");

/** Matches the spec fixture: broader context around the intended line went stale. */
const STALE_EDIT: Edit = {
	oldText: [
		"function calculateTotal(items) {",
		"  const total = items.reduce((sum, item) => sum + item, 0);",
		"",
	].join("\n"),
	newText: [
		"function calculateTotal(items) {",
		"  const total = items.reduce((sum, item) => sum + item, 0) || 0;",
		"",
	].join("\n"),
};

const RECOVERED_FILE = [
	"function calculateTotal(items) {",
	"  // Keep calculation centralized.",
	"  const total = items.reduce((sum, item) => sum + item, 0) || 0;",
	"  return total;",
	"}",
	"",
].join("\n");

describe("planStaleRegionRecovery (pure planner)", () => {
	it("recovers a single safe stale region and preserves the intended new text exactly", () => {
		const plan = planStaleRegionRecovery(STALE_FILE, STALE_EDIT);
		expect(plan.status).toBe("recovered");
		if (plan.status !== "recovered") return;
		expect(plan.region.oldText).toBe("  const total = items.reduce((sum, item) => sum + item, 0);");
		expect(plan.region.newText).toBe("  const total = items.reduce((sum, item) => sum + item, 0) || 0;");
		expect(plan.region.metadata).toMatchObject({
			strategy: "structural-anchor",
			conflict: "stale_region",
			candidateCount: 1,
			fileChanged: true,
			startLine: 3,
			endLine: 3,
			replacedLineCount: 1,
			insertedLineCount: 1,
		});
	});

	it("never mutates its inputs", () => {
		const content = STALE_FILE;
		const edit = { ...STALE_EDIT };
		const before = JSON.stringify({ content, edit });
		planStaleRegionRecovery(content, edit);
		expect(JSON.stringify({ content, edit })).toBe(before);
	});

	it("returns multiple_candidates without choosing when two regions match", () => {
		const content = [
			"function loadA() {",
			"  const value = parse(input);",
			"  return value;",
			"}",
			"",
			"function loadB() {",
			"  const value = parse(input);",
			"  return value;",
			"}",
			"",
		].join("\n");
		const edit: Edit = {
			oldText: ["function loadA() {", "  const value = parse(input);", "  return value;", "}"].join("\n"),
			newText: ["function loadA() {", "  const value = parse(input, defaults);", "  return value;", "}"].join("\n"),
		};
		const plan = planStaleRegionRecovery(content, edit);
		expect(plan.status).toBe("conflict");
		if (plan.status !== "conflict") return;
		expect(plan.conflict.reason).toBe("multiple_candidates");
		expect(plan.conflict.candidateCount).toBe(2);
		expect(plan.conflict.closestRegion).toBeNull();
	});

	it("returns target_not_found when nothing matches", () => {
		const plan = planStaleRegionRecovery("const a = 1;\n", { oldText: "const b = 2;\n", newText: "const c = 3;\n" });
		expect(plan.status).toBe("conflict");
		if (plan.status !== "conflict") return;
		expect(plan.conflict.reason).toBe("target_not_found");
		expect(plan.conflict.candidateCount).toBe(0);
	});

	it("refuses nearby unrelated similar text instead of picking the closest string", () => {
		const plan = planStaleRegionRecovery("const total = compute(items);\n", {
			oldText: "const total = compute(item);\n",
			newText: "const sum = compute(item);\n",
		});
		expect(plan.status).toBe("conflict");
		if (plan.status !== "conflict") return;
		expect(plan.conflict.reason).toBe("target_not_found");
	});

	it("refuses a candidate that crosses a declaration boundary", () => {
		const content = ["function a() {", "  doStuff();", "}", ""].join("\n");
		const plan = planStaleRegionRecovery(content, {
			oldText: "  doStuff();\n}\n",
			newText: "  doOtherStuff();\n",
		});
		expect(plan.status).toBe("conflict");
		if (plan.status !== "conflict") return;
		expect(plan.conflict.reason).toBe("unsafe_recovery");
		expect(plan.conflict.candidateCount).toBe(1);
		expect(plan.conflict.closestRegion).toMatchObject({ startLine: 2, endLine: 3 });
	});

	it("refuses a pure insertion, where no old-side target can be anchored", () => {
		const plan = planStaleRegionRecovery(STALE_FILE, {
			oldText: "function calculateTotal(items) {\n  const total = items.reduce((sum, item) => sum + item, 0);\n",
			newText:
				"function calculateTotal(items) {\n  const total = items.reduce((sum, item) => sum + item, 0);\n  if (total < 0) return 0;\n",
		});
		expect(plan.status).toBe("conflict");
		if (plan.status !== "conflict") return;
		expect(plan.conflict.reason).toBe("unsafe_recovery");
	});

	it("bounds previews and never leaks large source content", () => {
		const filler = Array.from({ length: 400 }, (_, index) => `line_${index}_${"x".repeat(200)}`);
		const content = [...filler, "function a() {", "  doStuff();", "}"].join("\n");
		const plan = planStaleRegionRecovery(content, {
			oldText: "  doStuff();\n}\n",
			newText: "  doOtherStuff();\n",
		});
		expect(plan.status).toBe("conflict");
		if (plan.status !== "conflict") return;
		expect(plan.conflict.closestRegion).not.toBeNull();
		expect(plan.conflict.closestRegion?.preview.length ?? 0).toBeLessThanOrEqual(483);
		expect(plan.conflict.closestRegion?.preview).not.toContain("line_399");
	});

	it("has no imports (no model, classifier, embedding, or filesystem dependency)", async () => {
		const source = await readFile(new URL("../src/core/tools/edit-recovery.ts", import.meta.url), "utf-8");
		expect(source.match(/^import\s/gm) ?? []).toEqual([]);
		expect(source).not.toMatch(/ask_user/);
	});
});

describe("applyEditsWithRecovery", () => {
	it("keeps the exact fast path unchanged: no recovery metadata on a clean match", () => {
		const content = "alpha\nbeta\ngamma\n";
		const result = applyEditsWithRecovery(content, [{ oldText: "beta\n", newText: "BETA\n" }], "a.ts");
		expect(result.newContent).toBe("alpha\nBETA\ngamma\n");
		expect(result.recovery).toBeUndefined();
	});

	it("recovers exactly one stale region and reports bounded metadata", () => {
		const result = applyEditsWithRecovery(STALE_FILE, [STALE_EDIT], "calc.js");
		expect(result.newContent).toBe(RECOVERED_FILE);
		expect(result.recovery).toMatchObject({
			strategy: "structural-anchor",
			conflict: "stale_region",
			candidateCount: 1,
			fileChanged: true,
			startLine: 3,
			endLine: 3,
		});
	});

	it("throws a structured EDIT_CONFLICT for ambiguous candidates", () => {
		const content = ["const value = parse(input);", "const value = parse(input);", ""].join("\n");
		expect(() =>
			applyEditsWithRecovery(
				content,
				[{ oldText: "const value = parse(input);\n", newText: "const value = parse2(input);\n" }],
				"a.ts",
			),
		).toThrowError(/^EDIT_CONFLICT\nfile: a\.ts\nreason: multiple_candidates\n/);
	});

	it("passes unrelated failures through untouched", () => {
		const content = "alpha\n";
		expect(() => applyEditsWithRecovery(content, [{ oldText: "alpha\n", newText: "alpha\n" }], "a.ts")).toThrowError(
			/No changes/,
		);
	});
});

describe("edit tool recovery end to end", () => {
	it("recovers a stale exact edit on disk without touching unrelated lines", async () => {
		const dir = await createTempDir();
		const file = join(dir, "calc.js");
		await writeFile(file, STALE_FILE, "utf-8");
		const tool = createEditTool(dir);

		const result = await tool.execute("t1", { path: file, edits: [STALE_EDIT] });

		expect(await readFile(file, "utf-8")).toBe(RECOVERED_FILE);
		expect((result.details as { recovery?: unknown } | undefined)?.recovery).toBeDefined();
	});

	it("does not mutate the file when candidates are ambiguous", async () => {
		const dir = await createTempDir();
		const file = join(dir, "dup.js");
		const content = ["const value = parse(input);", "const value = parse(input);", ""].join("\n");
		await writeFile(file, content, "utf-8");
		const tool = createEditTool(dir);

		await expect(
			tool.execute("t1", {
				path: file,
				edits: [{ oldText: "const value = parse(input);\n", newText: "const value = parse2(input);\n" }],
			}),
		).rejects.toThrowError(/EDIT_CONFLICT[\s\S]*reason: multiple_candidates/);

		expect(await readFile(file, "utf-8")).toBe(content);
	});

	it("does not mutate the file when no candidate exists", async () => {
		const dir = await createTempDir();
		const file = join(dir, "none.js");
		const content = "const a = 1;\n";
		await writeFile(file, content, "utf-8");
		const tool = createEditTool(dir);

		await expect(
			tool.execute("t1", { path: file, edits: [{ oldText: "const b = 2;\n", newText: "const c = 3;\n" }] }),
		).rejects.toThrowError(/EDIT_CONFLICT[\s\S]*reason: target_not_found/);

		expect(await readFile(file, "utf-8")).toBe(content);
	});

	it("preserves the existing multiple-exact-match conflict behavior", async () => {
		const dir = await createTempDir();
		const file = join(dir, "dup2.js");
		const content = "same\nsame\n";
		await writeFile(file, content, "utf-8");
		const tool = createEditTool(dir);

		await expect(
			tool.execute("t1", { path: file, edits: [{ oldText: "same\n", newText: "different\n" }] }),
		).rejects.toThrowError(
			/EDIT_CONFLICT[\s\S]*reason: multiple_candidates[\s\S]*candidate_count: 2[\s\S]*detail: Found 2 occurrences/,
		);

		expect(await readFile(file, "utf-8")).toBe(content);
	});

	it("reports filesystem failures as normal tool errors, not conflicts", async () => {
		const dir = await createTempDir();
		const tool = createEditTool(dir);

		await expect(
			tool.execute("t1", {
				path: join(dir, "missing.js"),
				edits: [{ oldText: "a\n", newText: "b\n" }],
			}),
		).rejects.toThrowError(/ENOENT/);
	});

	it("routes a recovered edit through custom edit operations exactly once", async () => {
		const dir = await createTempDir();
		const file = join(dir, "calc.js");
		await writeFile(file, STALE_FILE, "utf-8");

		const writes: string[] = [];
		const reads: string[] = [];
		const tool = createEditTool(dir, {
			operations: {
				readFile: async (absolutePath) => {
					reads.push(absolutePath);
					return readFileAsBuffer(absolutePath);
				},
				writeFile: async (absolutePath, content) => {
					writes.push(content);
					await writeFile(absolutePath, content, "utf-8");
				},
				access: async () => {},
			},
		});

		const result = await tool.execute("t1", { path: file, edits: [STALE_EDIT] });

		expect((result.details as { recovery?: unknown } | undefined)?.recovery).toBeDefined();
		expect(writes).toEqual([RECOVERED_FILE]);
		expect(reads).toEqual([file]);
	});
});

function toolStart(
	toolCallId: string,
	toolName: string,
	args: unknown,
): Parameters<SessionTelemetry["onAgentEvent"]>[0] {
	return { type: "tool_execution_start", toolCallId, toolName, args } as Parameters<
		SessionTelemetry["onAgentEvent"]
	>[0];
}

function toolEnd(
	toolCallId: string,
	toolName: string,
	isError: boolean,
	result: unknown,
): Parameters<SessionTelemetry["onAgentEvent"]>[0] {
	return { type: "tool_execution_end", toolCallId, toolName, result, isError } as Parameters<
		SessionTelemetry["onAgentEvent"]
	>[0];
}

describe("editing telemetry", () => {
	it("counts a recovered edit as one failure, one conflict, one retry, and one success", async () => {
		const dir = await createTempDir();
		const file = join(dir, "calc.js");
		await writeFile(file, STALE_FILE, "utf-8");
		const tool = createEditTool(dir);
		const result = await tool.execute("t1", { path: file, edits: [STALE_EDIT] });

		const telemetry = new SessionTelemetry();
		await telemetry.onAgentEvent(toolStart("t1", "edit", { path: file, edits: [STALE_EDIT] }), dir);
		await telemetry.onAgentEvent(toolEnd("t1", "edit", false, result), dir);

		expect(
			telemetry.snapshot({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
				.editing,
		).toEqual({
			attempts: 1,
			successful: 1,
			failed: 1,
			conflicts: 1,
			retries: 1,
		});
	});

	it("counts a clean exact edit with no conflict or retry", async () => {
		const telemetry = new SessionTelemetry();
		await telemetry.onAgentEvent(toolStart("t1", "edit", { path: "a.ts", edits: [] }), process.cwd());
		await telemetry.onAgentEvent(
			toolEnd("t1", "edit", false, { content: [{ type: "text", text: "ok" }], details: {} }),
			process.cwd(),
		);

		expect(
			telemetry.snapshot({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
				.editing,
		).toEqual({
			attempts: 1,
			successful: 1,
			failed: 0,
			conflicts: 0,
			retries: 0,
		});
	});

	it("counts an unresolved EDIT_CONFLICT as a failure and conflict without a retry", async () => {
		const dir = await createTempDir();
		const file = join(dir, "conflict.js");
		await writeFile(file, "const a = 1;\n", "utf-8");
		const tool = createEditTool(dir);
		let message = "";
		try {
			await tool.execute("t1", { path: file, edits: [{ oldText: "const b = 2;\n", newText: "const c = 3;\n" }] });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("EDIT_CONFLICT");

		const telemetry = new SessionTelemetry();
		await telemetry.onAgentEvent(toolStart("t1", "edit", { path: file, edits: [] }), dir);
		await telemetry.onAgentEvent(toolEnd("t1", "edit", true, { content: [{ type: "text", text: message }] }), dir);

		expect(
			telemetry.snapshot({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
				.editing,
		).toEqual({
			attempts: 1,
			successful: 0,
			failed: 1,
			conflicts: 1,
			retries: 0,
		});
	});
});
