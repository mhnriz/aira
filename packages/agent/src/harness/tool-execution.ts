import { type ToolResultMessage, type Usage, validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentToolCall, AgentToolResult, AgentToolUpdateCallback } from "../types.ts";
import type { HarnessTool } from "./agent-harness.ts";
import type { Session } from "./session/session.ts";
import { assertJsonSerializable } from "./session/session.ts";
import type {
	JsonValue,
	NewRecord,
	ToolEffectReplay,
	ToolExecutionStateRecord,
	ToolExecutionStatus,
} from "./session/types.ts";

export type DurableToolOutcome = {
	content: JsonValue;
	details?: JsonValue;
	usage?: JsonValue;
	addedToolNames?: string[];
	terminate?: boolean;
	isError: boolean;
};

export type ToolExecutionWait =
	| { kind: "completed"; state: ToolExecutionStateRecord; result: DurableToolOutcome }
	| { kind: "waiting"; state: ToolExecutionStateRecord }
	| { kind: "interrupted"; state: ToolExecutionStateRecord; result: DurableToolOutcome }
	| { kind: "cancelled"; state: ToolExecutionStateRecord; result: DurableToolOutcome }
	| { kind: "failed"; state: ToolExecutionStateRecord; result: DurableToolOutcome };

export type PreparedTool = {
	tool: HarnessTool;
	args: Record<string, JsonValue>;
};

function textResult(text: string, isError = true): DurableToolOutcome {
	return { content: [{ type: "text", text }], isError };
}

function toOutcome(result: AgentToolResult<unknown>, isError: boolean): DurableToolOutcome {
	const outcome: DurableToolOutcome = {
		content: result.content as unknown as JsonValue,
		isError,
		...(result.details === undefined ? {} : { details: result.details as unknown as JsonValue }),
		...(result.usage === undefined ? {} : { usage: result.usage as unknown as JsonValue }),
		...(result.addedToolNames === undefined ? {} : { addedToolNames: [...result.addedToolNames] }),
		...(result.terminate === undefined ? {} : { terminate: result.terminate }),
	};
	assertJsonSerializable(outcome);
	return structuredClone(outcome);
}

function outcomeMessage(call: ToolExecutionStateRecord, outcome: DurableToolOutcome): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		content: outcome.content as unknown as AgentToolResult<unknown>["content"],
		...(outcome.details === undefined ? {} : { details: outcome.details }),
		...(outcome.usage === undefined ? {} : { usage: outcome.usage as unknown as Usage }),
		...(outcome.addedToolNames === undefined ? {} : { addedToolNames: outcome.addedToolNames }),
		isError: outcome.isError,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

function stateWith(
	state: ToolExecutionStateRecord,
	status: ToolExecutionStatus,
	id: string,
	fields: { outcome?: JsonValue; errorMessage?: string } = {},
): NewRecord<ToolExecutionStateRecord> {
	return {
		...state,
		id,
		status,
		...(fields.outcome === undefined ? {} : { outcome: structuredClone(fields.outcome) }),
		...(fields.errorMessage === undefined ? {} : { errorMessage: fields.errorMessage }),
	};
}

/** Deterministic tool preparation. Invalid or missing tools never become durable executable intent. */
export function prepareToolCall(call: AgentToolCall, tools: readonly HarnessTool[]): PreparedTool | DurableToolOutcome {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) return textResult(`Tool ${JSON.stringify(call.name)} is unavailable`);
	try {
		const prepared = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const args = validateToolArguments(tool, {
			...call,
			arguments: prepared as Record<string, unknown>,
		}) as unknown as Record<string, JsonValue>;
		assertJsonSerializable(args);
		return { tool, args };
	} catch (error) {
		return textResult(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Lane-owned durable tool execution. The tool effect is admitted only after the
 * effect_pending record commits. Unsafe uncertain effects become interrupted
 * rather than being replayed automatically.
 */
export class DurableToolExecution {
	private readonly session: Session;
	private readonly lane: string;

	constructor(session: Session, lane: string) {
		this.session = session;
		this.lane = lane;
	}

	async start(options: {
		runId: string;
		assistantEntryId: string;
		toolIndex: number;
		call: AgentToolCall;
		args: Record<string, JsonValue>;
		replay?: ToolEffectReplay;
	}): Promise<ToolExecutionStateRecord> {
		return this.session.startToolExecution({
			lane: this.lane,
			runId: options.runId,
			assistantEntryId: options.assistantEntryId,
			toolIndex: options.toolIndex,
			toolCallId: options.call.id,
			toolName: options.call.name,
			args: options.args,
			replay: options.replay ?? "never",
		});
	}

	async run(
		state: ToolExecutionStateRecord,
		tools: readonly HarnessTool[],
		signal: AbortSignal = new AbortController().signal,
	): Promise<ToolExecutionWait> {
		if (state.status === "completed") {
			return { kind: "completed", state, result: state.outcome as unknown as DurableToolOutcome };
		}
		if (
			state.status === "outcome_ready" ||
			state.status === "failed" ||
			state.status === "cancelled" ||
			state.status === "interrupted"
		) {
			return { kind: "waiting", state };
		}
		if (state.status === "effect_pending" && state.replay === "never") {
			const interrupted = await this.session.commitToolOutcome({
				lane: this.lane,
				expected: { id: state.id, status: state.status },
				state,
				status: "interrupted",
				outcome: textResult("Tool execution was interrupted; external completion is unknown."),
			});
			if (!interrupted) return { kind: "waiting", state };
			return {
				kind: "interrupted",
				state: interrupted,
				result: interrupted.outcome as unknown as DurableToolOutcome,
			};
		}

		const pending = await this.session.transitionToolExecution(
			this.lane,
			{ id: state.id, status: state.status },
			stateWith(state, "effect_pending", this.session.idGenerator.next()),
		);
		if (!pending) return { kind: "waiting", state };
		if (signal.aborted) return this.cancel(pending);

		const prepared = prepareToolCall(
			{ type: "toolCall", id: pending.toolCallId, name: pending.toolName, arguments: pending.args },
			tools,
		);
		if (!("tool" in prepared)) {
			const failed = await this.session.commitToolOutcome({
				lane: this.lane,
				expected: { id: pending.id, status: "effect_pending" },
				state: pending,
				status: "failed",
				outcome: prepared as unknown as JsonValue,
			});
			return failed
				? { kind: "failed", state: failed, result: failed.outcome as unknown as DurableToolOutcome }
				: { kind: "waiting", state: pending };
		}

		let durableState = pending;
		let checkpointChain = Promise.resolve();
		let acceptingUpdates = true;
		const onUpdate: AgentToolUpdateCallback<unknown> = (partial) => {
			if (!acceptingUpdates) return;
			const checkpoint = toOutcome(partial, false);
			checkpointChain = checkpointChain.then(async () => {
				const next = await this.session.checkpointToolExecution(
					this.lane,
					{ id: durableState.id, status: durableState.status },
					checkpoint,
				);
				if (next) durableState = next;
			});
		};

		try {
			const result = await prepared.tool.execute(pending.toolCallId, prepared.args, signal, onUpdate);
			acceptingUpdates = false;
			await checkpointChain;
			const outcome = toOutcome(result, false);
			const completed = await this.session.commitToolOutcome({
				lane: this.lane,
				expected: { id: durableState.id, status: durableState.status },
				state: durableState,
				outcome,
			});
			return completed ? { kind: "waiting", state: completed } : { kind: "waiting", state: durableState };
		} catch (error) {
			acceptingUpdates = false;
			await checkpointChain;
			const outcome = textResult(error instanceof Error ? error.message : String(error));
			const status = signal.aborted ? "cancelled" : "failed";
			const completed = await this.session.commitToolOutcome({
				lane: this.lane,
				expected: { id: durableState.id, status: durableState.status },
				state: durableState,
				status,
				outcome,
			});
			return completed
				? { kind: status, state: completed, result: outcome }
				: { kind: "waiting", state: durableState };
		}
	}

	async cancel(state: ToolExecutionStateRecord): Promise<ToolExecutionWait> {
		const outcome = textResult("Tool execution was cancelled before completion.");
		const cancelled = await this.session.commitToolOutcome({
			lane: this.lane,
			expected: { id: state.id, status: state.status },
			state,
			status: "cancelled",
			outcome,
		});
		return cancelled ? { kind: "cancelled", state: cancelled, result: outcome } : { kind: "waiting", state };
	}

	async place(
		state: ToolExecutionStateRecord,
	): Promise<{ kind: "placed"; state: ToolExecutionStateRecord } | { kind: "waiting" }> {
		if (state.status === "completed") return { kind: "placed", state };
		if (state.outcome === undefined) return { kind: "waiting" };
		const result = {
			type: "message" as const,
			id: state.resultEntryId,
			message: outcomeMessage(state, state.outcome as unknown as DurableToolOutcome),
		};
		const placed = await this.session.placeToolOutcome({ lane: this.lane, state, result });
		if (!placed) return { kind: "waiting" };
		const latest = (
			await this.session.findRecords({
				lane: this.lane,
				type: "tool_execution_state",
				order: "newestFirst",
			})
		).find((record) => record.invocationId === state.invocationId);
		return latest ? { kind: "placed", state: latest } : { kind: "waiting" };
	}
}
