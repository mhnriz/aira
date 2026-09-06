import {
	type AssistantMessage,
	type DeferredHandle,
	isRetryableAssistantError,
	type RetryPolicy,
	type Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "../types.ts";
import type { Session } from "./session/session.ts";
import type {
	Entry,
	GenerationConfiguration,
	GenerationStateRecord,
	LaneRecord,
	NewRecord,
	OperationFinishedRecord,
	ProvisionedEntry,
} from "./session/types.ts";

export interface GenerationEffectInput {
	configuration: GenerationConfiguration;
	attempt: number;
	stepId: string;
	signal: AbortSignal;
}

export type GenerationEffect = (input: GenerationEffectInput) => Promise<AssistantMessage>;

export type GenerationWait =
	| { kind: "waiting"; status: "retry_wait" | "deferred"; notBefore?: number; deferred?: DeferredHandle }
	| { kind: "completed"; response: AssistantMessage }
	| { kind: "failed"; response: AssistantMessage }
	| { kind: "cancelled"; response?: AssistantMessage };

export interface GenerationRequest {
	lane: string;
	operationId: string;
	stepId?: string;
	originalPrompt?: AgentMessage[];
	initialMessages?: ProvisionedEntry[];
	configuration: GenerationConfiguration;
}

export interface GenerationConfigurationInput {
	model: { provider: string; modelId: string };
	thinkingLevel: string;
	streamOptions?: GenerationConfiguration["streamOptions"];
	retryPolicy: RetryPolicy;
}

function messageEntry(message: AssistantMessage, id: string): ProvisionedEntry<Extract<Entry, { type: "message" }>> {
	return { type: "message", id, message };
}

function usageRecord(
	state: GenerationStateRecord,
	message: AssistantMessage,
): NewRecord<Extract<LaneRecord, { type: "usage" }>> {
	return {
		type: "usage",
		id: state.usageId,
		lane: state.lane,
		cause: "assistant",
		runId: state.runId,
		entryId: state.responseEntryId,
		attempt: state.attempt,
		stopReason: message.stopReason === "pending" ? "error" : message.stopReason,
		usage: message.usage,
	};
}

function finishedRecord(
	state: GenerationStateRecord,
	outcome: OperationFinishedRecord["outcome"],
	message?: AssistantMessage,
): NewRecord<OperationFinishedRecord> {
	return {
		type: "operation_finished",
		id: `finish:${state.runId}:${state.attempt}`,
		lane: state.lane,
		runId: state.runId,
		outcome,
		...(message?.errorMessage ? { error: { code: "assistant_error", message: message.errorMessage } } : {}),
	};
}

function nextState(
	state: GenerationStateRecord,
	status: GenerationStateRecord["status"],
	ids: { responseEntryId: string; usageId: string },
	extra: Pick<GenerationStateRecord, "notBefore" | "errorMessage" | "deferred"> = {},
): NewRecord<GenerationStateRecord> {
	return {
		type: "generation_state",
		id: `generation:${state.runId}:${state.attempt}:${status}:${ids.responseEntryId}`,
		lane: state.lane,
		runId: state.runId,
		stepId: state.stepId,
		status,
		attempt: state.attempt,
		responseEntryId: ids.responseEntryId,
		usageId: ids.usageId,
		configuration: structuredClone(state.configuration),
		...(extra.notBefore === undefined ? {} : { notBefore: extra.notBefore }),
		...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
		...(extra.deferred === undefined ? {} : { deferred: structuredClone(extra.deferred) }),
	};
}

/**
 * Lane-owned durable generation coordinator. It persists intent and lifecycle
 * transitions; the supplied provider effect always runs after the transition
 * commits and never from inside Session's MutationLine.
 */
export class DurableGeneration {
	private readonly session: Session;
	private readonly lane: string;

	constructor(session: Session, lane: string) {
		this.session = session;
		this.lane = lane;
	}

	async start(request: Omit<GenerationRequest, "lane">): Promise<GenerationStateRecord> {
		return this.session.startGeneration({
			lane: this.lane,
			operationId: request.operationId,
			stepId: request.stepId ?? `step:${request.operationId}`,
			originalPrompt: request.originalPrompt ?? [],
			initialMessages: request.initialMessages,
			configuration: structuredClone(request.configuration),
			responseEntryId: this.session.idGenerator.next(),
			usageId: this.session.idGenerator.next(),
		});
	}

	async run(
		state: GenerationStateRecord,
		effect: GenerationEffect,
		signal: AbortSignal = new AbortController().signal,
	): Promise<GenerationWait> {
		if (state.status === "retry_wait" && state.notBefore !== undefined && Date.now() < state.notBefore) {
			return { kind: "waiting", status: "retry_wait", notBefore: state.notBefore };
		}
		const pending = await this.session.transitionGeneration(
			this.lane,
			{ id: state.id, status: state.status },
			{
				...nextState(state, "effect_pending", {
					responseEntryId: this.session.idGenerator.next(),
					usageId: this.session.idGenerator.next(),
				}),
				attempt: state.status === "intent" ? 1 : state.attempt + 1,
			},
		);
		if (pending === undefined) return { kind: "waiting", status: "retry_wait" };

		if (signal.aborted) {
			await this.cancel(pending);
			return { kind: "cancelled" };
		}
		const response = await effect({
			configuration: structuredClone(pending.configuration),
			attempt: pending.attempt,
			stepId: pending.stepId,
			signal,
		});
		return this.settle(pending, response);
	}

	async resume(state: GenerationStateRecord, effect: GenerationEffect, signal?: AbortSignal): Promise<GenerationWait> {
		return this.run(state, effect, signal);
	}

	async cancel(state: GenerationStateRecord): Promise<boolean> {
		if (state.status === "settled" || state.status === "cancelled") return false;
		const next = nextState(state, "cancelled", {
			responseEntryId: state.responseEntryId,
			usageId: state.usageId,
		});
		const transitioned = await this.session.transitionGeneration(
			this.lane,
			{ id: state.id, status: state.status },
			next,
		);
		if (!transitioned) return false;
		await this.session.appendRecord(finishedRecord(transitioned, "aborted"));
		return true;
	}

	private async settle(state: GenerationStateRecord, response: AssistantMessage): Promise<GenerationWait> {
		const isAborted = response.stopReason === "aborted";
		const retryable = response.stopReason === "error" && isRetryableAssistantError(response);
		const retriesRemaining =
			state.configuration.retryPolicy.enabled && state.attempt <= state.configuration.retryPolicy.maxRetries;
		if (isAborted) {
			const committed = await this.commitTerminal(state, response, "cancelled");
			return committed ? { kind: "cancelled", response } : { kind: "waiting", status: "retry_wait" };
		}
		if (response.stopReason === "deferred" && response.deferred === undefined) {
			const committed = await this.commitTerminal(state, response, "failed");
			return committed ? { kind: "failed", response } : { kind: "waiting", status: "retry_wait" };
		}
		if (response.stopReason === "deferred") {
			const committed = await this.commitTerminal(state, response, "deferred");
			return committed
				? { kind: "waiting", status: "deferred", deferred: response.deferred }
				: { kind: "waiting", status: "deferred" };
		}
		if (retryable && retriesRemaining) {
			const delayMs = state.configuration.retryPolicy.baseDelayMs * 2 ** Math.max(0, state.attempt - 1);
			const retry = nextState(
				state,
				"retry_wait",
				{
					responseEntryId: state.responseEntryId,
					usageId: state.usageId,
				},
				{
					notBefore: Date.now() + delayMs,
					errorMessage: response.errorMessage ?? "Assistant request failed",
				},
			);
			const committed = await this.session.commitGenerationOutcome({
				lane: this.lane,
				expected: { id: state.id, status: "effect_pending" },
				response: messageEntry(response, state.responseEntryId),
				usage: usageRecord(state, response),
				nextState: retry,
			});
			return committed
				? { kind: "waiting", status: "retry_wait", notBefore: retry.notBefore }
				: { kind: "waiting", status: "retry_wait" };
		}
		const committed = await this.commitTerminal(
			state,
			response,
			response.stopReason === "error" ? "failed" : "settled",
		);
		return response.stopReason === "error"
			? committed
				? { kind: "failed", response }
				: { kind: "waiting", status: "retry_wait" }
			: committed
				? { kind: "completed", response }
				: { kind: "waiting", status: "retry_wait" };
	}

	private async commitTerminal(
		state: GenerationStateRecord,
		response: AssistantMessage,
		status: Extract<GenerationStateRecord["status"], "cancelled" | "deferred" | "settled"> | "failed",
	): Promise<boolean> {
		const terminalStatus = status === "failed" ? "settled" : status;
		const next = nextState(state, terminalStatus, {
			responseEntryId: state.responseEntryId,
			usageId: state.usageId,
			...(response.deferred === undefined ? {} : { deferred: response.deferred }),
		});
		return this.session.commitGenerationOutcome({
			lane: this.lane,
			expected: { id: state.id, status: "effect_pending" },
			response: messageEntry(response, state.responseEntryId),
			usage: usageRecord(state, response),
			nextState: next,
			finish:
				status === "deferred"
					? undefined
					: finishedRecord(
							state,
							status === "cancelled" ? "aborted" : status === "failed" ? "failed" : "completed",
							response,
						),
		});
	}
}

export function generationConfiguration(input: GenerationConfigurationInput): GenerationConfiguration {
	return {
		model: structuredClone(input.model),
		thinkingLevel: input.thinkingLevel,
		streamOptions: structuredClone(input.streamOptions ?? {}),
		retryPolicy: structuredClone(input.retryPolicy),
	};
}

export type { DeferredHandle, Usage };
