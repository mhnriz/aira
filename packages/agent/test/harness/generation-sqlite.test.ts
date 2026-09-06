import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepository } from "../../../session-backends/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { DurableGeneration, generationConfiguration } from "../../src/harness/generation.ts";
import { DurableOperationBoundary } from "../../src/harness/operation-boundary.ts";

const roots: string[] = [];

function response(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "sqlite" }],
		api: "openai-completions",
		provider: "provider-a",
		model: "model-a",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("SQLite durable generation", () => {
	it("persists and consumes the lane inbox without replay after reopen", async () => {
		const root = mkdtempSync(join(tmpdir(), "aira-operation-sqlite-"));
		roots.push(root);
		let repository = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});
		try {
			let session = await repository.create({ id: "sqlite-operation", cwd: root });
			const boundary = new DurableOperationBoundary(session, "main");
			await boundary.enqueue("nextRun", {
				type: "message",
				id: "sqlite-queued",
				message: { role: "user", content: [{ type: "text", text: "queued" }], timestamp: 1 },
			});
			await session.appendRecord({
				type: "operation_started",
				id: "sqlite-operation-id",
				lane: "main",
				sourceLeafId: null,
				intent: { kind: "run", originalPrompt: [], initialMessages: [] },
			});
			expect(await boundary.consumeInbox("sqlite-operation-id", ["sqlite-queued"])).toBe(true);
			const metadata = await session.getMetadata();
			await repository.close();
			repository = new SqliteSessionRepository({
				env: new NodeExecutionEnv({ cwd: root }),
				sqlite: createNodeSqliteFactory(),
				databasePath: join(root, "sessions.sqlite"),
			});
			session = await repository.open(metadata);
			expect(await new DurableOperationBoundary(session, "main").listInbox()).toEqual([]);
		} finally {
			await repository.close();
		}
	});

	it("reopens pending generation state and settles it once", async () => {
		const root = mkdtempSync(join(tmpdir(), "aira-generation-sqlite-"));
		roots.push(root);
		let repository = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});
		try {
			let session = await repository.create({ id: "sqlite-generation", cwd: root });
			const generation = new DurableGeneration(session, "main");
			const started = await generation.start({
				operationId: "sqlite-run",
				configuration: generationConfiguration({
					model: { provider: "provider-a", modelId: "model-a" },
					thinkingLevel: "off",
					retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
				}),
			});
			const metadata = await session.getMetadata();
			await repository.close();
			repository = new SqliteSessionRepository({
				env: new NodeExecutionEnv({ cwd: root }),
				sqlite: createNodeSqliteFactory(),
				databasePath: join(root, "sessions.sqlite"),
			});
			session = await repository.open(metadata);
			const result = await new DurableGeneration(session, "main").resume(started, async () => response());
			expect(result.kind).toBe("completed");
			expect(await session.findOpenOperations("main")).toEqual([]);
			expect((await session.findRecords({ type: "generation_state", runId: "sqlite-run" }))[0]?.status).toBe(
				"settled",
			);
		} finally {
			await repository.close();
		}
	});
});
