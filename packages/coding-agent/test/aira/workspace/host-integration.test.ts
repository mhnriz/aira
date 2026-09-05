/** Phase 13 host boundary: repair commands cannot erase pre-existing dirt. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolCall, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../suite/harness.ts";

const sessions: Array<{ harness: Harness; root: string }> = [];

afterEach(() => {
	for (const { harness, root } of sessions.splice(0)) {
		harness.session.dispose();
		harness.faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});

function context(command: string): BeforeToolCallContext {
	const toolCall = {
		type: "toolCall",
		id: "repair-1",
		name: "bash",
		arguments: { command },
	} as unknown as AgentToolCall;
	return {
		toolCall,
		args: { command },
		assistantMessage: fauxAssistantMessage(fauxText("repair")) as AssistantMessage,
		context: { systemPrompt: "", messages: [] },
	};
}

function gitRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "aira-ownership-host-"));
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "docs"));
	mkdirSync(join(root, "test"));
	writeFileSync(join(root, "src", "baseline.txt"), "committed\n");
	writeFileSync(join(root, "docs", "phase.md"), "committed report\n");
	writeFileSync(join(root, "src", "inspector.ts"), "committed browser fix\n");
	writeFileSync(join(root, "test", "inspector.test.ts"), "committed regression\n");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "aira@test"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Aira Test"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
	writeFileSync(join(root, "src", "baseline.txt"), "pre-existing user work\n");
	writeFileSync(join(root, "docs", "phase.md"), "pre-existing report\n");
	writeFileSync(join(root, "src", "inspector.ts"), "pre-existing browser fix\n");
	writeFileSync(join(root, "test", "inspector.test.ts"), "pre-existing regression\n");
	return root;
}

describe("Aira workspace ownership host integration", () => {
	it("blocks a repair restore of pre-existing dirt at beforeToolCall", async () => {
		const root = gitRepo();
		const harness = await createHarness({ cwd: root, settings: { goals: { auto: "off" } } as never });
		sessions.push({ harness, root });
		await harness.session.airaIntelligence?.waitUntilSettled();
		expect(harness.session.airaGoal?.create("read the workspace and report").ok).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const paths = ["docs/phase.md", "src/inspector.ts", "test/inspector.test.ts"];
		const before = paths.map((path) => readFileSync(join(root, path), "utf8"));
		const verification = await harness.session.airaVerification?.verify();
		expect(verification?.outcome).toBe("skipped");
		const result = await harness.session.agent.beforeToolCall?.(context(`git restore -- ${paths.join(" ")}`));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("protected pre-existing workspace change");
		expect(paths.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(before);
	});
});
