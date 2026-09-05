/**
 * Phase 13 regression coverage for Goal completion boundaries that can be
 * reached by either the root agent or the canonical task graph.
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createAiraGoalManager } from "../../../src/aira/goal/manager.ts";
import type { AiraGoalSettings } from "../../../src/aira/goal/settings.ts";
import { acquireAiraSessionState } from "../../../src/aira/state.ts";
import type { AiraTaskManagerHandle } from "../../../src/aira/tasks/manager.ts";
import type { AiraTask, AiraTasksStatus } from "../../../src/aira/tasks/types.ts";
import type { AiraVerificationHandle } from "../../../src/aira/verification/manager.ts";
import {
	type AiraVerificationResult,
	type AiraVerificationStatus,
	initialAiraVerificationStatus,
} from "../../../src/aira/verification/types.ts";

function taskStatus(overrides: Partial<AiraTasksStatus> = {}): AiraTasksStatus {
	return {
		enabled: true,
		total: 0,
		pending: 0,
		active: 0,
		blocked: 0,
		completed: 0,
		cancelled: 0,
		failed: 0,
		current: undefined,
		rows: [],
		childRows: 0,
		updatedAt: Date.now(),
		summary: "0/0",
		...overrides,
	};
}

class TaskStatusSource implements AiraTaskManagerHandle {
	private readonly listeners = new Set<(status: AiraTasksStatus) => void>();
	private current: AiraTasksStatus;
	private readonly state: ReturnType<typeof acquireAiraSessionState>;

	constructor(state: ReturnType<typeof acquireAiraSessionState>, initial: AiraTasksStatus) {
		this.state = state;
		this.current = initial;
		this.state.tasks = initial;
	}

	emit(status: AiraTasksStatus): void {
		this.current = status;
		this.state.tasks = status;
		for (const listener of [...this.listeners]) listener(status);
	}

	create(): { ok: false; message: string } {
		return { ok: false, message: "test task source does not create tasks" };
	}

	patch(): { ok: false; message: string } {
		return { ok: false, message: "test task source does not patch tasks" };
	}

	get(): AiraTask | undefined {
		return undefined;
	}

	list(): AiraTask[] {
		return [];
	}

	complete(): { ok: false; message: string } {
		return { ok: false, message: "test task source does not complete tasks" };
	}

	remove(): { ok: false; message: string } {
		return { ok: false, message: "test task source does not remove tasks" };
	}

	clear(): { ok: false; message: string } {
		return { ok: false, message: "test task source does not clear tasks" };
	}

	status(): AiraTasksStatus {
		return this.current;
	}

	consumeRecoveryHint(): string | undefined {
		return undefined;
	}

	subscribe(listener: (status: AiraTasksStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.listeners.clear();
	}
}

class CountingVerification implements AiraVerificationHandle {
	readonly state;
	readonly requests: string[] = [];
	readonly runs: AiraVerificationResult[] = [];
	private readonly skipUntilTaskCompletion: boolean;

	constructor(state: ReturnType<typeof acquireAiraSessionState>, skipUntilTaskCompletion = false) {
		this.state = state;
		this.skipUntilTaskCompletion = skipUntilTaskCompletion;
		this.state.verification = initialAiraVerificationStatus({
			enabled: true,
			auto: "always",
			contextBudget: "compact",
		});
	}

	async verify(): Promise<{
		ok: boolean;
		outcome: "ran" | "skipped";
		result?: AiraVerificationResult;
		reason?: string;
	}> {
		this.requests.push(this.state.tasks?.summary ?? "no tasks");
		if (this.skipUntilTaskCompletion && (this.state.tasks?.completed ?? 0) < (this.state.tasks?.total ?? 1)) {
			return { ok: false, outcome: "skipped", reason: "child completion not yet visible" };
		}
		const result: AiraVerificationResult = {
			id: `v-${this.runs.length + 1}`,
			revisionId: `rev-${this.runs.length + 1}`,
			verdict: "pass",
			summary: "all acceptance criteria verified",
			mode: "build",
			objective: "implement the goal",
			requirements: [],
			findings: [],
			evidence: [],
			missingEvidence: [],
			scopeAssessment: { verdict: "in-scope", notes: [] },
			confidence: "high",
			startedAt: Date.now(),
			completedAt: Date.now(),
			stale: false,
		};
		this.runs.push(result);
		this.state.verification = {
			...this.state.verification!,
			status: "passed",
			currentResult: result,
			completedAt: result.completedAt,
		};
		return { ok: true, outcome: "ran", result };
	}

	status(): AiraVerificationStatus {
		return this.state.verification!;
	}

	subscribe(): () => void {
		return () => undefined;
	}

	applyAgentEvent(): void {
		// no-op test seam
	}

	async dispose(): Promise<void> {
		return undefined;
	}
}

function agentEnd(): AgentEvent {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: "implement the goal" }], timestamp: Date.now() },
			{ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() },
		],
	} as AgentEvent;
}

interface Rig {
	manager: ReturnType<typeof createAiraGoalManager>;
	state: ReturnType<typeof acquireAiraSessionState>;
	tasks: TaskStatusSource;
	verification: CountingVerification;
	emit: (event: AgentEvent) => Promise<void>;
}

function makeRig(options: { skipUntilTaskCompletion?: boolean; enabled?: boolean } = {}): Rig {
	const state = acquireAiraSessionState(`goal-boundary-${Math.random().toString(36).slice(2)}`);
	const settings: AiraGoalSettings = {
		enabled: true,
		auto: "always",
		maxRounds: 4,
		tokenBudget: undefined,
		maxDurationMs: undefined,
	};
	const tasks = new TaskStatusSource(state, taskStatus());
	const verification = new CountingVerification(state, options.skipUntilTaskCompletion);
	if (options.enabled === false) {
		state.verification = { ...state.verification!, enabled: false };
	}
	let listener: ((event: AgentEvent) => void | Promise<void>) | undefined;
	const manager = createAiraGoalManager(state, {
		cwd: process.cwd(),
		sessionId: state.sessionId,
		startReason: "startup",
		settings: () => settings,
		verification,
		tasks,
		execution: undefined,
		agentEvents: (next) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	});
	manager.create("implement the goal");
	return {
		manager,
		state,
		tasks,
		verification,
		emit: async (event) => {
			await listener?.(event);
		},
	};
}

const pendingChildren = taskStatus({
	total: 2,
	pending: 1,
	active: 1,
	childRows: 2,
	rows: [
		{ id: "c-1", title: "one", status: "active", source: "child", dependsOn: [] },
		{ id: "c-2", title: "two", status: "pending", source: "child", dependsOn: [] },
	],
});

const completedChildren = taskStatus({
	total: 2,
	completed: 2,
	childRows: 2,
	rows: [
		{ id: "c-1", title: "one", status: "completed", source: "child", dependsOn: [] },
		{ id: "c-2", title: "two", status: "completed", source: "child", dependsOn: [] },
	],
});

describe("Goal completion verification boundaries (Phase 13)", () => {
	it("direct parent implementation reaches the verifier once", async () => {
		const rig = makeRig();
		await rig.emit(agentEnd());
		expect(rig.verification.runs).toHaveLength(1);
		expect(rig.state.goal?.status).toBe("completed");
		await rig.manager.dispose();
	});

	it("implement child completion triggers verification after the root boundary was skipped", async () => {
		const rig = makeRig({ skipUntilTaskCompletion: true });
		rig.tasks.emit(pendingChildren);
		await rig.emit(agentEnd());
		expect(rig.verification.runs).toHaveLength(0);
		rig.tasks.emit(completedChildren);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.verification.runs).toHaveLength(1);
		expect(rig.state.goal?.status).toBe("completed");
		await rig.manager.dispose();
	});

	it("multiple children completing runs verification once at the all-settled edge", async () => {
		const rig = makeRig({ skipUntilTaskCompletion: true });
		rig.tasks.emit(pendingChildren);
		await rig.emit(agentEnd());
		rig.tasks.emit(taskStatus({ total: 2, completed: 1, active: 1, childRows: 2 }));
		rig.tasks.emit(completedChildren);
		await new Promise((resolve) => setTimeout(resolve, 0));
		rig.tasks.emit(completedChildren);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.verification.runs).toHaveLength(1);
		await rig.manager.dispose();
	});

	it("resumed child-backed goals verify when the recovered task graph completes", async () => {
		const rig = makeRig({ skipUntilTaskCompletion: true });
		rig.tasks.emit(taskStatus({ total: 1, pending: 1, childRows: 1 }));
		expect(rig.manager.stop().ok).toBe(true);
		expect(rig.manager.resume().ok).toBe(true);
		rig.tasks.emit(taskStatus({ total: 1, completed: 1, childRows: 1 }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.verification.runs).toHaveLength(1);
		expect(rig.state.goal?.status).toBe("completed");
		await rig.manager.dispose();
	});

	it("resuming a paused goal rechecks an already-settled recovered graph", async () => {
		const rig = makeRig({ skipUntilTaskCompletion: true });
		rig.tasks.emit(taskStatus({ total: 1, pending: 1, childRows: 1 }));
		expect(rig.manager.stop().ok).toBe(true);
		rig.tasks.emit(taskStatus({ total: 1, completed: 1, childRows: 1 }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.verification.runs).toHaveLength(0);
		expect(rig.manager.resume().ok).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.verification.runs).toHaveLength(1);
		expect(rig.state.goal?.status).toBe("completed");
		await rig.manager.dispose();
	});

	it("disabled verification never runs at a task completion boundary", async () => {
		const rig = makeRig({ enabled: false });
		rig.tasks.emit(completedChildren);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.verification.runs).toHaveLength(0);
		expect(rig.state.goal?.status).toBe("active");
		await rig.manager.dispose();
	});

	it("repeated completion events and repeated root boundaries do not duplicate verification", async () => {
		const rig = makeRig({ skipUntilTaskCompletion: true });
		rig.tasks.emit(pendingChildren);
		await rig.emit(agentEnd());
		rig.tasks.emit(completedChildren);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await rig.emit(agentEnd());
		rig.tasks.emit(completedChildren);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.verification.runs).toHaveLength(1);
		expect(rig.verification.requests.length).toBeGreaterThanOrEqual(2);
		await rig.manager.dispose();
	});
});
