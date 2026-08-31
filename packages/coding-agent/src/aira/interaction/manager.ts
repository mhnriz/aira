/**
 * Aira interaction — per-session manager.
 *
 * The single canonical owner of native structured Q&A state (ADR-024
 * ownership pattern). At most one pending interaction exists per session:
 * permission ASK and the model-facing `ask_user` tool both go through this
 * manager, so there is exactly one "waiting for the user" state and no
 * second permission-dialog architecture.
 *
 * Resolution channels:
 * - an attached interactive UI bridge (the TUI dialog) calls `answer()`;
 * - the caller's AbortSignal resolves the interaction as cancelled;
 * - an optional per-request timeout resolves it as timed-out;
 * - no UI bridge attached → `ask()` resolves immediately as "unavailable"
 *   (truthful: the question was NOT asked; headless callers never hang);
 * - session dispose resolves any pending interaction as unavailable.
 *
 * The manager never fabricates an answer: cancelled/timed-out/unavailable
 * outcomes carry no selections/text.
 */
import { randomUUID } from "node:crypto";
import type { AiraSessionState } from "../state.ts";
import type {
	AiraInteractionAnswer,
	AiraInteractionRequest,
	AiraInteractionStatus,
	AiraInteractionType,
} from "./types.ts";

const MAX_QUESTION_CHARS = 500;
const MAX_CONTEXT_CHARS = 1200;
const MAX_CHOICES = 12;
const MAX_CHOICE_LABEL_CHARS = 120;
const MAX_CHOICE_DESCRIPTION_CHARS = 300;
const MAX_OWNER_CHARS = 80;
const MAX_CLOSED_HISTORY = 4;
const MAX_PROMPT_PROJECTION_CHARS = 200;

export interface AiraInteractionManagerOptions {
	/** Canonical settings accessor (live). May be undefined in tests. */
	settings?: () => { timeoutMs?: number };
	/** Goal seam (Phase 10): pending questions reflect into goal waiting. */
	goal?: {
		considerUserInteraction(change: {
			type: AiraInteractionType;
			state: "pending" | "answered" | "closed";
			prompt: string;
			detail?: string;
		}): void;
	};
	now?: () => number;
}

export interface AiraInteractionHandle {
	/**
	 * Open a bounded question and await the user's answer. Resolves
	 * immediately with resolution "unavailable" when no UI bridge is
	 * attached or another interaction is already pending (never hangs);
	 * "superseded" when another question was already open.
	 */
	ask(request: AiraInteractionRequest, signal?: AbortSignal): Promise<AiraInteractionAnswer>;
	/** Resolve a pending interaction from the interactive UI bridge. */
	answer(interactionId: string, answer: Omit<AiraInteractionAnswer, "interactionId" | "type">): boolean;
	/** Attach/detach the interactive UI bridge (TUI dialog). */
	attachUI(): void;
	detachUI(): void;
	/** Canonical snapshot (token-free; refreshed lazily). */
	status(): AiraInteractionStatus;
	subscribe(listener: (status: AiraInteractionStatus) => void): () => void;
	dispose(): void;
}

/** Create the session's interaction manager and return the handle. */
export function createAiraInteractionManager(
	state: AiraSessionState,
	options: AiraInteractionManagerOptions = {},
): AiraInteractionHandle {
	const manager = new AiraInteractionManager(state, options);
	manager.activate();
	return manager;
}

interface PendingInteraction {
	interactionId: string;
	request: AiraInteractionRequest;
	createdAt: number;
	timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	resolve: (answer: AiraInteractionAnswer) => void;
	abortListener: (() => void) | undefined;
	/** The AbortSignal whose listener is installed (removal needs the source). */
	signal: AbortSignal | undefined;
}

export class AiraInteractionManager implements AiraInteractionHandle {
	private readonly state: AiraSessionState;
	private readonly options: AiraInteractionManagerOptions;
	private pending: PendingInteraction | undefined;
	private uiAttached = false;
	private readonly closed: Array<{
		interactionId: string;
		type: AiraInteractionRequest["type"];
		prompt: string;
		resolution: AiraInteractionAnswer["resolution"];
		closedAt: number;
	}> = [];
	private readonly listeners = new Set<(status: AiraInteractionStatus) => void>();
	private snapshot: AiraInteractionStatus;
	private disposed = false;

	constructor(state: AiraSessionState, options: AiraInteractionManagerOptions = {}) {
		this.state = state;
		this.options = options;
		this.snapshot = this.buildSnapshot();
	}

	activate(): void {
		if (this.disposed) {
			return;
		}
		this.publish();
	}

	ask(request: AiraInteractionRequest, signal?: AbortSignal): Promise<AiraInteractionAnswer> {
		const normalized = normalizeAiraInteractionRequest(request);
		if (this.disposed) {
			return Promise.resolve(this.answerFor(normalized.type, "unavailable"));
		}
		if (this.pending) {
			// One question at a time: supersede truthfully (never stack dialogs).
			return Promise.resolve({
				interactionId: newInteractionId(),
				type: normalized.type,
				resolution: "superseded",
				selections: [],
			});
		}
		if (!this.uiAttached) {
			// Headless (print/RPC/SDK): the question is never shown to anyone.
			this.recordClosed(normalized, "unavailable");
			this.publish();
			return Promise.resolve(this.answerFor(normalized.type, "unavailable"));
		}
		if (signal?.aborted) {
			this.recordClosed(normalized, "cancelled");
			this.publish();
			return Promise.resolve(this.answerFor(normalized.type, "cancelled"));
		}

		const interactionId = newInteractionId();
		const timeoutMs = normalized.timeoutMs ?? this.options.settings?.().timeoutMs ?? 0;
		let resolve!: (answer: AiraInteractionAnswer) => void;
		const promise = new Promise<AiraInteractionAnswer>((res) => {
			resolve = res;
		});
		const pending: PendingInteraction = {
			interactionId,
			request: normalized,
			createdAt: this.now(),
			timeoutTimer: undefined,
			resolve,
			abortListener: undefined,
			signal: undefined,
		};
		pending.timeoutTimer =
			timeoutMs > 0 ? setTimeout(() => this.resolvePending(interactionId, "timed-out"), timeoutMs) : undefined;
		if (signal) {
			pending.abortListener = () => this.resolvePending(interactionId, "cancelled");
			pending.signal = signal;
			signal.addEventListener("abort", pending.abortListener, { once: true });
		}
		this.pending = pending;
		this.notifyGoal({
			type: normalized.type,
			state: "pending",
			prompt: normalized.question,
			detail: normalized.owner,
		});
		this.publish();
		return promise;
	}

	answer(interactionId: string, answer: Omit<AiraInteractionAnswer, "interactionId" | "type">): boolean {
		const pending = this.pending;
		if (!pending || pending.interactionId !== interactionId) {
			return false;
		}
		this.resolvePending(interactionId, answer.resolution, answer);
		return true;
	}

	attachUI(): void {
		if (this.uiAttached) {
			return;
		}
		this.uiAttached = true;
		this.publish();
	}

	detachUI(): void {
		if (!this.uiAttached) {
			return;
		}
		this.uiAttached = false;
		this.publish();
	}

	status(): AiraInteractionStatus {
		this.publish();
		return this.snapshot;
	}

	subscribe(listener: (status: AiraInteractionStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.resolvePendingAll("unavailable");
		this.listeners.clear();
		this.publish();
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	private resolvePending(
		interactionId: string,
		resolution: AiraInteractionAnswer["resolution"],
		answer?: Pick<AiraInteractionAnswer, "selections" | "text" | "decision">,
	): void {
		const pending = this.pending;
		if (!pending || pending.interactionId !== interactionId) {
			return;
		}
		this.clearPendingTimers(pending);
		this.pending = undefined;
		const complete: AiraInteractionAnswer = {
			interactionId,
			type: pending.request.type,
			resolution,
			selections: resolution === "answered" ? [...(answer?.selections ?? [])] : [],
			...(resolution === "answered" && answer?.text !== undefined ? { text: answer.text } : {}),
			...(resolution === "answered" && answer?.decision !== undefined ? { decision: answer.decision } : {}),
		};
		pending.resolve(complete);
		this.recordClosed(pending.request, resolution);
		this.notifyGoal({
			type: pending.request.type,
			state: resolution === "answered" ? "answered" : "closed",
			prompt: pending.request.question,
			detail: pending.request.owner,
		});
		this.publish();
	}

	private resolvePendingAll(resolution: AiraInteractionAnswer["resolution"]): void {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		this.clearPendingTimers(pending);
		this.pending = undefined;
		pending.resolve({
			interactionId: pending.interactionId,
			type: pending.request.type,
			resolution,
			selections: [],
		});
		this.recordClosed(pending.request, resolution);
		this.notifyGoal({
			type: pending.request.type,
			state: "closed",
			prompt: pending.request.question,
			detail: pending.request.owner,
		});
	}

	private clearPendingTimers(pending: PendingInteraction): void {
		if (pending.timeoutTimer) {
			clearTimeout(pending.timeoutTimer);
			pending.timeoutTimer = undefined;
		}
		if (pending.abortListener && pending.signal) {
			pending.signal.removeEventListener("abort", pending.abortListener);
			pending.abortListener = undefined;
			pending.signal = undefined;
		}
	}

	private recordClosed(request: AiraInteractionRequest, resolution: AiraInteractionAnswer["resolution"]): void {
		this.closed.unshift({
			interactionId: newInteractionId(),
			type: request.type,
			prompt: boundedText(request.question, MAX_PROMPT_PROJECTION_CHARS),
			resolution,
			closedAt: this.now(),
		});
		if (this.closed.length > MAX_CLOSED_HISTORY) {
			this.closed.length = MAX_CLOSED_HISTORY;
		}
	}

	private notifyGoal(change: {
		type: AiraInteractionType;
		state: "pending" | "answered" | "closed";
		prompt: string;
		detail?: string;
	}): void {
		try {
			this.options.goal?.considerUserInteraction(change);
		} catch {
			// The goal seam must never break interaction state.
		}
	}

	private answerFor(
		type: AiraInteractionType,
		resolution: AiraInteractionAnswer["resolution"],
	): AiraInteractionAnswer {
		return { interactionId: newInteractionId(), type, resolution, selections: [] };
	}

	private buildSnapshot(): AiraInteractionStatus {
		const pending = this.pending;
		const now = this.now();
		if (!pending) {
			return {
				pending: false,
				question: undefined,
				recentClosed: this.closed.slice(0, MAX_CLOSED_HISTORY),
				uiAttached: this.uiAttached,
				updatedAt: now,
				summary: "idle",
			};
		}
		return {
			pending: true,
			question: {
				interactionId: pending.interactionId,
				type: pending.request.type,
				prompt: boundedText(pending.request.question, MAX_PROMPT_PROJECTION_CHARS),
				...(pending.request.context ? { context: boundedText(pending.request.context, 400) } : {}),
				choices: (pending.request.choices ?? []).map((choice) => ({
					id: choice.id,
					label: choice.label,
					...(choice.description ? { description: choice.description } : {}),
				})),
				choicesCount: pending.request.choices?.length ?? 0,
				multiSelect: pending.request.multiSelect === true,
				freeform: pending.request.freeform === true,
				owner: pending.request.owner,
				waitingSince: pending.createdAt,
				durationMs: now - pending.createdAt,
			},
			recentClosed: this.closed.slice(0, MAX_CLOSED_HISTORY),
			uiAttached: this.uiAttached,
			updatedAt: now,
			summary: `question pending (${pending.request.type})`,
		};
	}

	private publish(): void {
		this.snapshot = this.buildSnapshot();
		this.state.interaction = this.snapshot;
		for (const listener of [...this.listeners]) {
			listener(this.snapshot);
		}
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

/** Normalize + bound a raw interaction request (never throws). */
export function normalizeAiraInteractionRequest(request: AiraInteractionRequest): AiraInteractionRequest {
	const question = boundedText(request.question || "", MAX_QUESTION_CHARS);
	const seen = new Set<string>();
	const choices = (request.choices ?? [])
		.slice(0, MAX_CHOICES)
		.map((choice, index) => ({
			id: boundedText(choice.id || `c${index + 1}`, 40),
			label: boundedText(choice.label || `Option ${index + 1}`, MAX_CHOICE_LABEL_CHARS),
			...(choice.description ? { description: boundedText(choice.description, MAX_CHOICE_DESCRIPTION_CHARS) } : {}),
		}))
		.filter((choice) => {
			if (seen.has(choice.id)) {
				return false;
			}
			seen.add(choice.id);
			return true;
		});
	const timeoutMs = request.timeoutMs;
	return {
		type: request.type,
		question: question || "Question",
		...(request.context ? { context: boundedText(request.context, MAX_CONTEXT_CHARS) } : {}),
		...(choices.length > 0 ? { choices } : {}),
		...(request.multiSelect === true && choices.length > 0 ? { multiSelect: true } : {}),
		...(request.freeform === true ? { freeform: true } : {}),
		...(request.owner ? { owner: boundedText(request.owner, MAX_OWNER_CHARS) } : {}),
		...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs: Math.min(86_400_000, Math.floor(timeoutMs)) } : {}),
	};
}

function boundedText(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 1)}…`;
}

function newInteractionId(): string {
	return `q-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
