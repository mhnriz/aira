import type { Session } from "./session/session.ts";
import type {
	GenerationStateRecord,
	OperationFinishedRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueEnqueuedRecord,
	ToolExecutionStateRecord,
} from "./session/types.ts";

export type OperationTerminalStatus = "completed" | "failed" | "cancelled" | "declined";

export interface OperationResult {
	operationId: string;
	status: OperationTerminalStatus;
	outcome: OperationFinishedRecord["outcome"];
	endedAt: number;
}

export type OperationObservation =
	| { kind: "unknown"; operationId: string }
	| {
			kind: "pending";
			operationId: string;
			operation: OperationStartedRecord;
			phase: "starting" | "running" | "waiting" | "cancellation_requested" | "interrupted";
	  }
	| { kind: "terminal"; operationId: string; result: OperationResult };

export type RecoveryAction =
	| { kind: "unknown"; operationId: string }
	| { kind: "resume_generation"; state: GenerationStateRecord }
	| { kind: "resume_tool"; state: ToolExecutionStateRecord }
	| { kind: "materialize_tool"; state: ToolExecutionStateRecord }
	| { kind: "reconcile_cancellation"; operationId: string }
	| { kind: "wait"; operationId: string; reason: "retry" | "deferred" }
	| { kind: "terminal"; result: OperationResult }
	| { kind: "interrupted"; operationId: string; reason: "unsafe_tool_effect" | "unknown_effect" };

function terminalStatus(outcome: OperationFinishedRecord["outcome"]): OperationTerminalStatus {
	switch (outcome) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "aborted":
			return "cancelled";
		case "declined":
			return "declined";
	}
}

function result(record: OperationFinishedRecord): OperationResult {
	return {
		operationId: record.runId,
		status: terminalStatus(record.outcome),
		outcome: record.outcome,
		endedAt: record.timestamp,
	};
}

function latest<T extends { seq: number }>(records: readonly T[]): T | undefined {
	return records.at(-1);
}

/** A small lane-owned boundary over the existing Session mutation protocol. */
export class DurableOperationBoundary {
	private readonly session: Session;
	private readonly lane: string;

	constructor(session: Session, lane: string) {
		this.session = session;
		this.lane = lane;
	}

	enqueue(
		queue: QueueEnqueuedRecord["queue"],
		target: ProvisionedEntry,
		operationId?: string,
	): Promise<QueueEnqueuedRecord> {
		return this.session.enqueueInboxItem(this.lane, queue, target, operationId);
	}

	listInbox(): Promise<QueueEnqueuedRecord[]> {
		return this.session.listInbox(this.lane);
	}

	consumeInbox(operationId: string, entryIds: readonly string[]): Promise<boolean> {
		return this.session.consumeInbox(this.lane, operationId, entryIds);
	}

	requestCancellation(
		operationId: string,
	): Promise<"requested" | "already_requested" | "already_terminal" | "unknown"> {
		return this.session.requestAbort(this.lane, operationId);
	}

	async observe(operationId: string): Promise<OperationObservation> {
		const starts = await this.session.findRecords({
			lane: this.lane,
			type: "operation_started",
			order: "oldestFirst",
		});
		const started = starts.find((record) => record.id === operationId);
		if (!started) return { kind: "unknown", operationId };
		const finished = latest(
			await this.session.findRecords({
				lane: this.lane,
				type: "operation_finished",
				runId: operationId,
				order: "oldestFirst",
			}),
		);
		if (finished) return { kind: "terminal", operationId, result: result(finished) };
		const abort = latest(
			await this.session.findRecords({
				lane: this.lane,
				type: "abort_requested",
				runId: operationId,
				order: "oldestFirst",
			}),
		);
		if (abort) return { kind: "pending", operationId, operation: started, phase: "cancellation_requested" };
		const generation = latest(
			await this.session.findRecords({
				lane: this.lane,
				type: "generation_state",
				runId: operationId,
				order: "oldestFirst",
			}),
		);
		if (generation?.status === "retry_wait" || generation?.status === "deferred") {
			return { kind: "pending", operationId, operation: started, phase: "waiting" };
		}
		const tool = latest(
			await this.session.findRecords({
				lane: this.lane,
				type: "tool_execution_state",
				runId: operationId,
				order: "oldestFirst",
			}),
		);
		const phase =
			tool?.status === "effect_pending" && tool.replay === "never"
				? "interrupted"
				: generation || tool
					? "running"
					: "starting";
		return { kind: "pending", operationId, operation: started, phase };
	}

	async recover(operationId: string): Promise<RecoveryAction> {
		const observation = await this.observe(operationId);
		if (observation.kind === "unknown") return observation;
		if (observation.kind === "terminal") return { kind: "terminal", result: observation.result };
		if (observation.phase === "cancellation_requested") return { kind: "reconcile_cancellation", operationId };
		const generation = latest(
			await this.session.findRecords({
				lane: this.lane,
				type: "generation_state",
				runId: operationId,
				order: "oldestFirst",
			}),
		);
		if (generation) {
			switch (generation.status) {
				case "intent":
				case "effect_pending":
					return { kind: "resume_generation", state: generation };
				case "retry_wait":
					return { kind: "wait", operationId, reason: "retry" };
				case "deferred":
					return { kind: "wait", operationId, reason: "deferred" };
				case "cancelled":
					return { kind: "reconcile_cancellation", operationId };
				case "settled":
					break;
			}
		}
		const tool = latest(
			await this.session.findRecords({
				lane: this.lane,
				type: "tool_execution_state",
				runId: operationId,
				order: "oldestFirst",
			}),
		);
		if (tool) {
			switch (tool.status) {
				case "planned":
				case "checkpointed":
				case "effect_pending":
					return tool.replay === "never" && tool.status === "effect_pending"
						? { kind: "interrupted", operationId, reason: "unsafe_tool_effect" }
						: { kind: "resume_tool", state: tool };
				case "outcome_ready":
				case "failed":
				case "cancelled":
				case "interrupted":
					return { kind: "materialize_tool", state: tool };
				case "completed":
					break;
			}
		}
		return { kind: "wait", operationId, reason: "retry" };
	}
}
