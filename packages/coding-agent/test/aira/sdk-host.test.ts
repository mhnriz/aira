import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("Aira SDK host wiring", () => {
	it("constructs the native runtime without a TUI or provider call", async () => {
		const root = mkdtempSync(join(tmpdir(), "aira-sdk-host-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		try {
			const { session } = await createAgentSession({
				cwd: project,
				agentDir,
				sessionManager: SessionManager.inMemory(project),
			});
			try {
				expect(session.airaSessionState.mode).toBe("build");
				expect(session.airaExecution).toBeDefined();
				expect(session.airaBrowser).toBeDefined();
				expect(session.airaVerification).toBeDefined();
				expect(session.airaOrchestration).toBeDefined();
				expect(session.airaGoal?.status().status).toBe("idle");
				expect(session.airaTasks?.status().enabled).toBe(true);
				session.setAiraMode("plan");
				expect(session.airaSessionState.mode).toBe("plan");
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
