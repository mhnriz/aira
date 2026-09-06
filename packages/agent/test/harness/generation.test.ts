import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { DurableGeneration, generationConfiguration } from "../../src/harness/generation.ts";
import {
	InMemorySessionRepo,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type Session,
} from "../../src/harness/session/index.ts";

const tempDirs: string[] = [];

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: stopReason === "stop" ? [{ type: "text", text: "ok" }] : [],
		api: "openai-completions",
		provider: "provider-a",
		model: "model-a",
		usage,
		stopReason,
		timestamp: Date.now(),
		...(errorMessage === undefined ? {} : { errorMessage }),
	};
}

async function createRepository(): Promise<{
	repository: InMemorySessionRepo | JsonlSessionRepo;
	cleanup: () => void;
}> {
	if (process.env.AIRA_GENERATION_JSONL !== "1") {
		return { repository: new InMemorySessionRepo(), cleanup: () => {} };
	}
	const root = mkdtempSync(join(tmpdir(), "aira-generation-"));
	tempDirs.push(root);
	return {
		repository: new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root }),
		cleanup: () => {},
	};
}

async function createSession(repository: InMemorySessionRepo | JsonlSessionRepo, id: string): Promise<Session> {
	return repository instanceof JsonlSessionRepo ? repository.create({ id, cwd: "/tmp" }) : repository.create({ id });
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("durable lane-owned generation", () => {
	it("captures configuration, persists retry state, and resumes once after reopen", async () => {
		const { repository, cleanup } = await createRepository();
		try {
			let session = await createSession(repository, "generation");
			const generation = new DurableGeneration(session, "main");
			const configuration = generationConfiguration({
				model: { provider: "provider-a", modelId: "model-a" },
				thinkingLevel: "high",
				retryPolicy: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
				streamOptions: { timeoutMs: 1000, metadata: { requestClass: "test" } },
			});
			const started = await generation.start({ operationId: "run-1", configuration });
			let effects = 0;
			const first = await generation.run(started, async (input) => {
				effects++;
				expect(input.configuration.model).toEqual(configuration.model);
				await session.appendCustomEntry("effect-outside-mutation");
				return response("error", "503 service unavailable");
			});
			expect(first).toMatchObject({ kind: "waiting", status: "retry_wait" });
			const retry = (await session.findRecords({ type: "generation_state", runId: "run-1" }))[0]!;
			const metadata = await session.getMetadata();
			if (repository instanceof JsonlSessionRepo) session = await repository.open(metadata as JsonlSessionMetadata);
			const reopened = new DurableGeneration(session, "main");
			const activeModel = { provider: "provider-b", modelId: "model-b" };
			const second = await reopened.resume(retry, async (input) => {
				effects++;
				expect(input.configuration.model).toEqual(configuration.model);
				expect(input.configuration.model).not.toEqual(activeModel);
				return response("stop");
			});
			expect(second.kind).toBe("completed");
			expect(effects).toBe(2);
			const states = await session.findRecords({ type: "generation_state", runId: "run-1", order: "oldestFirst" });
			expect(states.map((state) => state.status)).toEqual([
				"intent",
				"effect_pending",
				"retry_wait",
				"effect_pending",
				"settled",
			]);
			expect(await session.findOpenOperations("main")).toEqual([]);
			const usageRecords = await session.findRecords({ type: "usage", runId: "run-1" });
			expect(usageRecords).toHaveLength(2);
		} finally {
			cleanup();
		}
	});

	it("serializes concurrent resume and does not duplicate the provider effect", async () => {
		const { repository } = await createRepository();
		const session = await createSession(repository, "concurrent");
		const generation = new DurableGeneration(session, "main");
		const started = await generation.start({
			operationId: "run-2",
			configuration: generationConfiguration({
				model: { provider: "provider-a", modelId: "model-a" },
				thinkingLevel: "off",
				retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			}),
		});
		let release: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			release = resolve;
		});
		let effects = 0;
		const effect = async () => {
			effects++;
			await entered;
			return response("stop");
		};
		const first = generation.run(started, effect);
		await Promise.resolve();
		const second = generation.run(started, effect);
		release?.();
		const results = await Promise.all([first, second]);
		expect(effects).toBe(1);
		expect(results.filter((result) => result.kind === "completed")).toHaveLength(1);
		expect(await session.findOpenOperations("main")).toEqual([]);
	});

	it("keeps deferred state durable and distinguishes cancellation from failure", async () => {
		const { repository } = await createRepository();
		const session = await createSession(repository, "deferred");
		const generation = new DurableGeneration(session, "main");
		const started = await generation.start({
			operationId: "run-3",
			configuration: generationConfiguration({
				model: { provider: "provider-a", modelId: "model-a" },
				thinkingLevel: "off",
				retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
			}),
		});
		const deferred = await generation.run(started, async () => ({
			...response("deferred"),
			deferred: { provider: "provider-a", modelId: "model-a", api: "openai-completions", id: "handle-1" },
		}));
		expect(deferred).toMatchObject({ kind: "waiting", status: "deferred" });
		const deferredState = (await session.findRecords({ type: "generation_state", runId: "run-3" }))[0]!;
		expect(await generation.cancel(deferredState)).toBe(true);
		const latest = (await session.findRecords({ type: "generation_state", runId: "run-3" }))[0]!;
		expect(latest.status).toBe("cancelled");
		expect(await session.findOpenOperations("main")).toEqual([]);
	});
});
