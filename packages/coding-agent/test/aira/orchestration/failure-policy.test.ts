/**
 * Step 8 — task + capability failure policy.
 *
 * A failed child run must be classified once, truthfully, and surfaced to the
 * parent as either failed WORK (task_failure) or a failed CAPABILITY /
 * ENVIRONMENT / TIMEOUT / CANCELLATION (the work could not run). These tests
 * drive the canonical orchestration seam (real manager, injected runner) plus
 * the real task manager and SessionTelemetry, so classification, task metadata,
 * the model-facing result, and telemetry counters are checked end to end.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildAiraChildFailure, classifyAiraChildFailure } from "../../../src/aira/orchestration/failures.ts";
import {
	type AiraOrchestrationHandle,
	createAiraOrchestrationManager,
} from "../../../src/aira/orchestration/manager.ts";
import type { AiraChildOutcome, AiraChildRuntime } from "../../../src/aira/orchestration/runner.ts";
import type { AiraOrchestrationSettings } from "../../../src/aira/orchestration/settings.ts";
import { type AiraSessionState, acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { createAiraTaskManager } from "../../../src/aira/tasks/manager.ts";
import { renderSessionTelemetryJson, SessionTelemetry } from "../../../src/core/session-telemetry.ts";

const EMPTY_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
};

/** Snapshot the telemetry with empty usage: these tests assert agent counters. */
function telemetrySnapshot(telemetry: SessionTelemetry) {
	return telemetry.snapshot(EMPTY_USAGE);
}

const COMPLETED = {
	status: "completed" as const,
	summary: "mapped the module",
	findings: ["f1"],
	evidence: ["e1"],
	relevantFiles: ["src/a.ts"],
	changedFiles: [] as string[],
	tests: [] as string[],
	errors: [] as string[],
};

const defaultResolve = {
	runtime: { model: { id: "m" } as never, streamFn: (async () => ({ result: async () => ({}) })) as never },
	resolvedModel: "faux/fake-model",
};

interface PolicyFixture {
	handle: AiraOrchestrationHandle;
	tasks: ReturnType<typeof createAiraTaskManager>;
	telemetry: SessionTelemetry;
	state: AiraSessionState;
	runnerCalls: number;
	runner: {
		call: (options: { tools: string[]; signal?: AbortSignal }) => Promise<AiraChildOutcome> | AiraChildOutcome;
		resolveRuntime: () => Promise<
			{ runtime: AiraChildRuntime; resolvedModel: string } | { unavailable: string } | undefined
		>;
	};
}

const activeSessions: AiraSessionState[] = [];

function makeFixture(mode: "build" | "plan" = "build"): PolicyFixture {
	const state = acquireAiraSessionState(`step8-policy-${Math.random().toString(36).slice(2)}`);
	state.mode = mode;
	const telemetry = new SessionTelemetry();
	const fixture: PolicyFixture = {
		handle: undefined as never,
		tasks: undefined as never,
		telemetry,
		state,
		runnerCalls: 0,
		runner: {
			call: () => ({ ok: true as const, result: { ...COMPLETED }, model: "faux/fake-model" }),
			resolveRuntime: () => Promise.resolve(defaultResolve),
		},
	};
	const settings: AiraOrchestrationSettings = {
		enabled: true,
		maxParallel: 2,
		model: "inherit",
		timeoutMs: 300_000,
	};
	fixture.handle = createAiraOrchestrationManager(state, {
		cwd: "/proj/demo",
		settings: () => settings,
		resolveRuntime: () => fixture.runner.resolveRuntime(),
		runner: async (_runtime, runOptions, signal) => {
			fixture.runnerCalls++;
			const outcome = fixture.runner.call({
				tools: runOptions.tools.map((tool) => tool.name),
				signal,
			});
			return outcome instanceof Promise ? outcome : Promise.resolve(outcome);
		},
	});
	// Same wiring as the live session: child outcomes and task transitions flow
	// into canonical telemetry (categories only, never error prose).
	fixture.handle.subscribe((status) => {
		for (const child of status.children) {
			fixture.telemetry.observeChildRun({
				id: child.id,
				status: child.status,
				...(child.error ? { failureKind: child.error.kind } : {}),
			});
		}
	});
	fixture.tasks = createAiraTaskManager(state, {
		settings: () => ({ enabled: true }),
		orchestration: fixture.handle,
	});
	fixture.tasks.subscribe((status) => fixture.telemetry.observeTaskStatuses(status.rows));
	activeSessions.push(state);
	return fixture;
}

afterEach(() => {
	while (activeSessions.length > 0) {
		const state = activeSessions.pop()!;
		disposeAiraSessionState(state.sessionId, state);
	}
});

describe("Step 8 failure policy: normal completion", () => {
	it("keeps a successful child run free of failure machinery", async () => {
		const fixture = makeFixture();
		const result = await fixture.handle.schedule([{ id: "a", role: "explore", task: "map the module" }], {
			awaitResults: true,
		});
		expect(result.tasks[0]!.result).toMatchObject({ status: "completed" });
		expect(result.tasks[0]!.failure).toBeUndefined();
		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("completed");
		expect(run.error).toBeUndefined();

		const row = fixture.tasks.list()[0]!;
		expect(row.status).toBe("completed");
		expect(row.failureKind).toBeUndefined();
		expect(fixture.runnerCalls).toBe(1);

		const snapshot = telemetrySnapshot(fixture.telemetry);
		expect(snapshot.agent.childAgents).toBe(1);
		expect(snapshot.agent.childOutcomes.completed).toBe(1);
		expect(snapshot.agent.askUser).toBe(0);
		expect(snapshot.schemaVersion).toBe("1.4.0");
	});

	it("keeps the pending -> active -> completed task lifecycle intact", async () => {
		const fixture = makeFixture();
		await fixture.handle.schedule([{ id: "a", role: "explore", task: "map the module" }], { awaitResults: true });
		const transitions = telemetrySnapshot(fixture.telemetry).agent.taskTransitionsByType;
		expect(transitions["pending->active"]).toBe(1);
		expect(transitions["active->completed"]).toBe(1);
		// Step 8 probe: no evidence of a pending -> completed shortcut.
		expect(transitions["pending->completed"]).toBeUndefined();
	});
});

describe("Step 8 failure policy: real task failure", () => {
	it("classifies an unmet acceptance criterion as task_failure with evidence", async () => {
		const fixture = makeFixture();
		fixture.runner.call = () => ({
			ok: true as const,
			result: {
				...COMPLETED,
				status: "failed" as const,
				summary: "tests prove the proposed change is wrong",
				tests: ["vitest run src/x.test.ts"],
			},
			model: "faux/fake-model",
		});
		const result = await fixture.handle.schedule([{ id: "a", role: "implement", task: "make the change" }], {
			awaitResults: true,
		});

		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("failed");
		expect(run.error?.kind).toBe("task_failure");
		expect(run.error?.taskStatus).toBe("attempted");
		expect(run.error?.message).toBe("tests prove the proposed change is wrong");

		// The parent receives the classified failure AND the child's own evidence.
		expect(result.tasks[0]!.failure?.kind).toBe("task_failure");
		expect(result.tasks[0]!.failure?.taskStatus).toBe("attempted");
		expect(result.tasks[0]!.result).toMatchObject({
			status: "failed",
			summary: "tests prove the proposed change is wrong",
			tests: ["vitest run src/x.test.ts"],
		});

		// Task metadata distinguishes failed work from a failed mechanism.
		const row = fixture.tasks.list()[0]!;
		expect(row.status).toBe("failed");
		expect(row.failureKind).toBe("task_failure");
		expect(row.detail).toContain("task_failure");
		expect(row.detail).not.toContain("task not attempted");

		const snapshot = telemetrySnapshot(fixture.telemetry);
		expect(snapshot.agent.childOutcomes.taskFailed).toBe(1);
		expect(snapshot.agent.childOutcomes.capabilityFailed).toBe(0);
		expect(snapshot.agent.askUser).toBe(0);
	});
});

describe("Step 8 failure policy: capability failure before execution", () => {
	it("classifies an unresolvable child model as capability_failure, not task failure", async () => {
		const fixture = makeFixture();
		fixture.runner.resolveRuntime = async () => ({ unavailable: "opencode-go child session unavailable" });
		const result = await fixture.handle.schedule([{ id: "a", role: "implement", task: "make the change" }], {
			awaitResults: true,
		});

		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("failed");
		expect(run.error?.kind).toBe("capability_failure");
		expect(run.error?.taskStatus).toBe("not_attempted");
		expect(run.error?.component).toBe("child-model");
		expect(run.error?.operation).toBe("resolve");
		expect(run.error?.message).toBe("opencode-go child session unavailable");

		// The parent must not see task_failure for work that never ran.
		expect(result.tasks[0]!.failure?.kind).toBe("capability_failure");
		expect(JSON.stringify(result.tasks[0]!)).not.toContain("task_failure");
		expect(fixture.runnerCalls).toBe(0);

		const row = fixture.tasks.list()[0]!;
		expect(row.failureKind).toBe("capability_failure");
		expect(row.detail).toContain("task not attempted");

		const snapshot = telemetrySnapshot(fixture.telemetry);
		expect(snapshot.agent.childOutcomes.capabilityFailed).toBe(1);
		expect(snapshot.agent.childOutcomes.taskFailed).toBe(0);
		expect(snapshot.agent.askUser).toBe(0);
	});
});

describe("Step 8 failure policy: provider capability failure", () => {
	it("classifies a structured provider rejection as capability_failure and preserves its code", async () => {
		const fixture = makeFixture();
		fixture.runner.call = () => ({
			ok: false as const,
			driverError: "provider rejected child session creation",
			error: classifyAiraChildFailure({
				origin: "capability",
				message: "provider rejected child session creation",
				code: "MissingSessionID",
				status: 400,
				component: "child-provider",
				operation: "stream",
				taskStatus: "attempted",
			}),
		});
		const result = await fixture.handle.schedule([{ id: "a", role: "review", task: "review the change" }], {
			awaitResults: true,
		});

		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("failed");
		expect(run.error?.kind).toBe("capability_failure");
		expect(run.error?.code).toBe("MissingSessionID");
		expect(run.error?.component).toBe("child-provider");
		expect(run.error?.operation).toBe("stream");
		expect(run.error?.retryableHint).toBe("no");

		const failure = result.tasks[0]!.failure!;
		expect(failure.kind).toBe("capability_failure");
		expect(failure.code).toBe("MissingSessionID");
		expect(JSON.stringify(result.tasks[0]!)).not.toContain("task_failure");

		expect(telemetrySnapshot(fixture.telemetry).agent.childOutcomes.capabilityFailed).toBe(1);
		expect(telemetrySnapshot(fixture.telemetry).agent.askUser).toBe(0);
	});

	it("does not retry when the failure is marked retryable", async () => {
		const fixture = makeFixture();
		fixture.runner.call = () => ({
			ok: false as const,
			driverError: "provider throttled",
			error: classifyAiraChildFailure({ origin: "capability", status: 429, message: "provider throttled" }),
		});
		await fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }], { awaitResults: true });
		// retryableHint is advisory metadata: it never executes a retry.
		expect(fixture.handle.list()[0]!.error?.retryableHint).toBe("yes");
		expect(fixture.runnerCalls).toBe(1);
	});
});

describe("Step 8 failure policy: environment failure", () => {
	it("classifies a missing executable as environment_failure with component/operation/code", async () => {
		const fixture = makeFixture();
		fixture.runner.call = async () => {
			throw Object.assign(new Error("spawn csharp-ls ENOENT"), { code: "ENOENT" });
		};
		const result = await fixture.handle.schedule([{ id: "a", role: "implement", task: "fix the diagnostic" }], {
			awaitResults: true,
		});

		const run = fixture.handle.list()[0]!;
		expect(run.error?.kind).toBe("environment_failure");
		expect(run.error?.code).toBe("ENOENT");
		// The injected runner plays the child-execution seam, so the manager
		// attributes the failure to the orchestration seam it observed.
		expect(run.error?.component).toBe("orchestration");
		expect(run.error?.operation).toBe("execute");
		expect(run.error?.taskStatus).toBe("not_attempted");

		expect(result.tasks[0]!.failure?.kind).toBe("environment_failure");
		const snapshot = telemetrySnapshot(fixture.telemetry);
		expect(snapshot.agent.childOutcomes.environmentFailed).toBe(1);
		expect(snapshot.agent.askUser).toBe(0);
	});

	it("attributes an unavailable required capability to the concrete component, not the task", async () => {
		const fixture = makeFixture();
		// No executionManager in this fixture: a process-capability role cannot be
		// granted managed execution, which is a capability gap, not failed work.
		fixture.runner.call = () => ({ ok: false as const, driverError: "child execution aborted" });
		const result = await fixture.handle.schedule([{ id: "a", role: "test", task: "run the suite" }], {
			awaitResults: true,
		});
		const run = fixture.handle.list()[0]!;
		expect(run.capabilityGaps?.[0]?.component).toBe("process-manager");
		expect(run.error?.kind).toBe("capability_failure");
		expect(run.error?.component).toBe("process-manager");
		expect(result.tasks[0]!.failure?.kind).toBe("capability_failure");
		expect(result.tasks[0]!.failure?.taskStatus).toBe("not_attempted");
	});
});

describe("Step 8 failure policy: timeout, cancellation, unknown", () => {
	it("keeps timeout distinguishable and counts it as timed-out", async () => {
		const fixture = makeFixture();
		fixture.runner.call = () => ({
			ok: false as const,
			driverError: "child timed out after 30000ms",
			error: classifyAiraChildFailure({ timedOut: true, message: "child timed out after 30000ms" }),
		});
		const result = await fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }], { awaitResults: true });
		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("timed-out");
		expect(run.error?.kind).toBe("timeout");
		expect(result.tasks[0]!.failure?.kind).toBe("timeout");
		expect(telemetrySnapshot(fixture.telemetry).agent.childOutcomes.timedOut).toBe(1);
		expect(telemetrySnapshot(fixture.telemetry).agent.askUser).toBe(0);
	});

	it("keeps user cancellation distinguishable from failure", async () => {
		const fixture = makeFixture();
		let childSignal: AbortSignal | undefined;
		fixture.runner.call = ({ signal }) =>
			new Promise((resolve) => {
				childSignal = signal;
				signal?.addEventListener("abort", () => resolve({ ok: false as const, driverError: "child cancelled" }), {
					once: true,
				});
			});
		const scheduled = fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }], { awaitResults: true });
		const deadline = Date.now() + 5_000;
		while (!childSignal && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(childSignal).toBeDefined();
		fixture.handle.cancel(undefined, "user abort");
		const result = await scheduled;
		const run = fixture.handle.list()[0]!;
		expect(childSignal?.aborted).toBe(true);
		expect(run.status).toBe("cancelled");
		expect(run.error?.kind).toBe("cancelled");
		expect(result.tasks[0]!.failure?.kind).toBe("cancelled");
		expect(telemetrySnapshot(fixture.telemetry).agent.childOutcomes.cancelled).toBe(1);
	});

	it("keeps an unclassified error representable as unknown_failure", async () => {
		const fixture = makeFixture();
		fixture.runner.call = () => ({
			ok: false as const,
			driverError: "mysterious",
			error: buildAiraChildFailure({ message: "mysterious" }),
		});
		const result = await fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }], { awaitResults: true });
		const run = fixture.handle.list()[0]!;
		expect(run.error?.kind).toBe("unknown_failure");
		expect(result.tasks[0]!.failure?.kind).toBe("unknown_failure");
		expect(telemetrySnapshot(fixture.telemetry).agent.childOutcomes.unknownFailed).toBe(1);
	});
});

describe("Step 8 failure policy: telemetry truthfulness", () => {
	it("counts outcomes by category without leaking error prose or secrets", async () => {
		const fixture = makeFixture();
		fixture.runner.call = () => ({
			ok: false as const,
			driverError: "HTTP 401 authorization: Bearer sk-live-abcdef0123456789 rejected",
			error: buildAiraChildFailure({
				kind: "capability_failure",
				message: "HTTP 401 authorization: Bearer sk-live-abcdef0123456789 rejected",
				component: "child-provider",
				operation: "stream",
				taskStatus: "not_attempted",
			}),
		});
		await fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }], { awaitResults: true });
		// The run record keeps sanitized evidence...
		expect(fixture.handle.list()[0]!.error?.message).not.toContain("sk-live-abcdef0123456789");
		// ...while the telemetry artifact carries categories only.
		const snapshot = telemetrySnapshot(fixture.telemetry);
		const json = renderSessionTelemetryJson(snapshot);
		expect(snapshot.schemaVersion).toBe("1.4.0");
		expect(snapshot.agent.childOutcomes.capabilityFailed).toBe(1);
		expect(json).not.toContain("sk-live-abcdef0123456789");
		expect(json).not.toContain("Bearer");
		expect(json).not.toContain("rejected");
	});

	it("does not trigger ask_user for an ordinary capability failure", async () => {
		const fixture = makeFixture();
		fixture.runner.call = () => ({
			ok: false as const,
			driverError: "child provider temporarily unavailable",
			error: buildAiraChildFailure({
				kind: "capability_failure",
				message: "child provider temporarily unavailable",
			}),
		});
		await fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }], { awaitResults: true });
		expect(telemetrySnapshot(fixture.telemetry).agent.askUser).toBe(0);
	});
});
