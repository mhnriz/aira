/**
 * Phase 9 — child context envelope: bounded explicit context, no transcript
 * injection, mode-aware read-only enforcement framing, structured result
 * contract in every envelope.
 */
import { describe, expect, it } from "vitest";
import {
	boundChildList,
	boundChildText,
	buildAiraChildEnvelope,
	MAX_CHILD_CONTEXT_CHARS,
	MAX_CHILD_FILES,
	MAX_CHILD_SUMMARY_CHARS,
} from "../../../src/aira/orchestration/envelope.ts";

const PROJECT = {
	root: "/proj/demo",
	git: { hasGit: true, root: "/proj/demo" },
	confidence: "medium" as const,
	languages: ["typescript"],
	frameworks: ["react"],
	packageManagers: ["npm"],
	testCommands: ["npm test"],
	buildCommands: ["npm run build"],
	checkCommands: ["npm run check"],
	devCommands: ["npm run dev"],
	browserRelevant: false,
	deploymentHints: [],
};

function envelopeFor(overrides: Partial<Parameters<typeof buildAiraChildEnvelope>[0]> = {}) {
	return buildAiraChildEnvelope({
		role: "explore",
		task: "Map the player module and how streams switch.",
		mode: "build",
		projectRoot: "/proj/demo",
		project: PROJECT,
		files: ["src/player.ts", "src/streams.ts"],
		context: "Recent change: seek() was edited.",
		mutatingAllowed: false,
		modelLabel: "faux/provider-model",
		...overrides,
	});
}

describe("Aira child context envelope (Phase 9)", () => {
	it("carries task, role, project, files, mode, and the result contract", () => {
		const envelope = envelopeFor();
		expect(envelope.prompt).toContain("## Task");
		expect(envelope.prompt).toContain("Map the player module");
		expect(envelope.prompt).toContain("## Role");
		expect(envelope.prompt).toContain(`## Project`);
		expect(envelope.prompt).toContain("src/player.ts");
		expect(envelope.prompt).toContain("## Execution mode");
		expect(envelope.prompt).toContain("BUILD");
		expect(envelope.prompt).toContain("## Result contract");
		expect(envelope.prompt).toContain('"status": "completed" | "failed"');
		expect(envelope.prompt).toContain('"changedFiles"');
		expect(envelope.systemPrompt).toContain('role "Explore"');
		expect(envelope.systemPrompt).toContain("You do not spawn further agents");
	});

	it("never contains a parent conversation (no transcript injection)", () => {
		const envelope = envelopeFor();
		expect(envelope.prompt.length + envelope.systemPrompt.length).toBeLessThan(6_000);
		expect(envelope.prompt).not.toContain("assistant");
		expect(envelope.prompt).not.toContain("toolResult");
	});

	it("read-only enforcement is framed explicitly when mutation is not allowed", () => {
		const envelope = envelopeFor({ mutatingAllowed: false });
		expect(envelope.prompt).toContain("## Read-only enforcement");
		expect(envelope.prompt).toContain("You may only read, search, and inspect");
		expect(envelope.prompt).toContain("NO tools that write the workspace");
		const build = envelopeFor({ mutatingAllowed: true });
		expect(build.prompt).not.toContain("## Read-only enforcement");
	});

	it("bounds task text, context, and file lists", () => {
		const longTask = "x".repeat(MAX_CHILD_CONTEXT_CHARS * 2);
		const envelope = envelopeFor({ task: longTask, context: longTask });
		expect(boundChildText(longTask, 4000).length).toBeLessThanOrEqual(4000);
		expect(envelope.prompt).not.toContain(longTask);
		const manyFiles = Array.from({ length: 200 }, (_, index) => `src/file${index}.ts`);
		expect(boundChildList(manyFiles, MAX_CHILD_FILES, 200)).toHaveLength(MAX_CHILD_FILES);
	});

	it("summaries are bounded by the contract constants", () => {
		expect(MAX_CHILD_SUMMARY_CHARS).toBe(600);
		const bounded = boundChildText("y".repeat(1000), MAX_CHILD_SUMMARY_CHARS);
		expect(bounded.length).toBeLessThanOrEqual(MAX_CHILD_SUMMARY_CHARS);
		expect(bounded.endsWith("…")).toBe(true);
	});

	it("PLAN envelopes carry the read-only framing for read-only roles", () => {
		const envelope = envelopeFor({ mode: "plan", mutatingAllowed: false });
		expect(envelope.prompt).toContain("PLAN");
		expect(envelope.prompt).toContain("## Read-only enforcement");
	});
});
