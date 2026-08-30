/**
 * Aira goal — per-session manager.
 *
 * The single canonical owner of the native Goal Runtime (ADR-024 ownership
 * pattern, mirroring execution/browser/verification/orchestration). The Goal
 * Runtime is a COORDINATOR: it owns the objective and lifecycle, and it
 * triggers — but never re-implements — the existing native services:
 *
 * - Phase 8 verifier = independent completion authority (the goal NEVER
 *   influences verdict content; PASS completes, FAIL drives a bounded repair
 *   continuation, INCONCLUSIVE drives bounded evidence acquisition or a
 *   truthful waiting state);
 * - Phase 9 task graph = execution decomposition (the goal only projects it);
 * - Phase 6 execution runtime = bounded evidence acquisition (tests);
 * - Phase 7 browser = evidence only (browser.* settings respected; the goal
 *   never forces browser use);
 * - the root agent = implementation (continuations are goal-owned turns with
 *   bounded repair directives, never the previous conversation).
 *
 * Bounds (hard): maxRounds, optional tokenBudget, optional maxDurationMs,
 * no-progress detection (identical revision + blocking finding across
 * consecutive rounds), and repeated-identical-verdict detection. Aira stops
 * rather than thrashes; the root session always stays usable.
 *
 * Ownership: one canonical goal per session; state survives within the
 * runtime and — bounded, machine-readable — across restarts for the SAME
 * session id (never inherited by new/fork sessions; a running-class goal at
 * crash time recovers as paused, never auto-resumes).
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AiraChildTokenUsage } from "../orchestration/types.ts";
import type { AiraSessionState } from "../state.ts";
import type { AiraChangeFile } from "../verification/eligibility.ts";
import type { AiraVerificationHandle } from "../verification/manager.ts";
import type { AiraVerificationResult } from "../verification/types.ts";
import { decideAiraGoalPromotion } from "./eligibility.ts";
import { type AiraGoalPersistence, type AiraGoalPersistenceRecord, createAiraGoalPersistence } from "./persistence.ts";
import { isNoProgress, isRepeatedVerdict } from "./progress.ts";
import { type AiraGoalRepairContext, buildAiraGoalContinuationPrompt } from "./prompt.ts";
import type { AiraGoalSettings } from "./settings.ts";
import { assertAiraGoalTransition } from "./state-machine.ts";
import type {
	AiraGoalSnapshot,
	AiraGoalStatus,
	AiraGoalStopReason,
	AiraGoalTaskProjection,
	AiraGoalUsage,
	AiraGoalVerificationProjection,
	AiraGoalWaiting,
} from "./types.ts";
import { AIRA_GOAL_CLEARABLE_STATUSES, AIRA_GOAL_RUNNING_STATUSES, AIRA_GOAL_TERMINAL_STATUSES } from "./types.ts";
import {
	type AiraSessionUsageSnapshot,
	budgetBoundVerdict,
	computeAiraGoalUsage,
	mergeAiraChildTokenUsage,
} from "./usage.ts";

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_OBJECTIVE_SNAPSHOT_CHARS = 400;
const MAX_LAST_EVENT_CHARS = 200;
const MAX_WAITING_DETAIL_CHARS = 300;
const MAX_ACQUISITION_TIMEOUT_MS = 600_000;
const MAX_MISSING_EVIDENCE_SNAPSHOT = 4;
const MAX_MISSING_EVIDENCE_CHARS = 120;

export interface AiraGoalManagerOptions {
	/** Session working directory. */
	cwd: string;
	/** Session id (ownership identity). */
	sessionId: string;
	/** Host session start reason ("startup" | "new" | "fork" | "resume" | ...). */
	startReason: string;
	/** Canonical settings accessor (live — changes take effect immediately). */
	settings: () => AiraGoalSettings;
	/** Canonical verification handle (Phase 8) — the completion authority. */
	verification: AiraVerificationHandle | undefined;
	/** Execution handle (Phase 6) — bounded evidence acquisition. */
	execution: AiraExecutionHandleLike | undefined;
	/** Host session usage seam (session stats; undefined = usage unknown). */
	usageSeam?: () => AiraSessionUsageSnapshot | undefined;
	/** True when user messages are queued (steer preservation; continuation defers). */
	hasPendingMessages?: () => boolean;
	/**
	 * Host continuation seam: start a goal-owned turn (custom message,
	 * display:false). Returns false when the host could not send it. The
	 * turn's content is a bounded repair directive, never a transcript.
	 */
	sendContinuation?: (text: string) => Promise<boolean>;
	/** Host abort seam: abort the agent run in flight (stop/cancel propagation). */
	abortRun?: () => void;
	/**
	 * Host agent-event subscription seam (listener order decides completion-
	 * boundary precedence; the host enriches agent_end with its willRetry
	 * truth so the goal never reacts to a run the host is about to retry).
	 */
	agentEvents: (listener: (event: AgentEvent) => void | Promise<void>) => () => void;
	/** Repository change seam (revision fingerprinting; undefined when unavailable). */
	changeSeam?: () => Promise<AiraChangeFile[] | undefined>;
	/** Persistence seam (tests inject temp dirs / disabled storage). */
	persistence?: AiraGoalPersistence;
	/** Elapsed-time source (tests inject a clock). */
	now?: () => number;
}

/** Minimal execution-handle surface the goal consumes (Phase 6 owner). */
export interface AiraExecutionHandleLike {
	start(
		request: { command?: string; exe?: string; args?: readonly string[]; cwd: string },
		options?: { purpose?: "run" | "test" | "build" | "check" | "dev" | "other"; timeoutMs?: number },
	): Promise<{ ok: boolean; status: string; exitCode?: number | null; reason?: string }>;
}

export type AiraGoalActionResult =
	| { ok: true; status: AiraGoalStatus; message: string }
	| { ok: false; status: AiraGoalStatus; message: string };

export interface AiraGoalHandle {
	/** User message seam: promote / resume / steer on real user prompts. */
	considerUserObjective(text: string): void;
	/** Manual goal creation (explicit user intent; no SMART gate). */
	create(objective: string): AiraGoalActionResult;
	/** Feed host agent events (completion-boundary subscription). */
	applyAgentEvent(event: AgentEvent): void | Promise<void>;
	/** `/goal stop` — halt continuation, preserve state, allow resume. */
	stop(): AiraGoalActionResult;
	/** `/goal resume` — continue a paused/waiting goal. */
	resume(): AiraGoalActionResult;
	/** Cancel active execution and mark the goal cancelled. */
	cancel(): AiraGoalActionResult;
	/** Clear terminal/paused goal state (lifecycle rules enforced). */
	clear(): AiraGoalActionResult;
	/** Canonical snapshot (token-free; refreshed lazily). */
	status(): AiraGoalSnapshot;
	subscribe(listener: (snapshot: AiraGoalSnapshot) => void): () => void;
	dispose(): Promise<void>;
}

interface AiraGoalState {
	id: string;
	objective: string;
	status: AiraGoalStatus;
	round: number;
	createdAt: number;
	startedAt: number;
	updatedAt: number;
	completedAt: number | undefined;
	stopReason: AiraGoalStopReason | undefined;
	waiting: AiraGoalWaiting | undefined;
	/** Last verified revision id (fingerprinting). */
	revisionId: string | undefined;
	lastVerdict: "pass" | "fail" | "inconclusive" | undefined;
	/** Highest blocking finding message of the last FAIL (fingerprinting). */
	lastBlockingFinding: string | undefined;
	/** Round the last observation belongs to. */
	observedRound: number;
	/** Usage baseline (session stats at goal start). */
	usageBaseline: AiraSessionUsageSnapshot | undefined;
	/** Child-usage baseline (orchestration aggregate seen at last commit). */
	childUsageBaseline: AiraChildTokenUsage | undefined;
	/** Cumulative child tokens attributed to the goal (committed at boundaries). */
	childrenTokens: number;
	/** Verifier tokens counted so far (per-result, seen once). */
	verifierTokens: number;
	/** Last verification result id consumed (dedupe across boundaries). */
	lastResultId: string | undefined;
	/** Last consumed verification result revision (unchanged-revision dedupe). */
	lastRevisionId: string | undefined;
	/** Continuation pending/in-flight (the current round is goal-owned). */
	continuationPending: boolean;
	/** Round that already performed evidence acquisition. */
	evidenceAcquisitionRound: number;
	/** Bounded repair context of the last FAIL (resume without a fresh result). */
	repairContext: AiraGoalRepairContext | undefined;
	lastEvent: string | undefined;
}

export class AiraGoalManager implements AiraGoalHandle {
	private readonly state: AiraSessionState;
	private readonly options: AiraGoalManagerOptions;
	private goal: AiraGoalState | undefined;
	private readonly listeners = new Set<(snapshot: AiraGoalSnapshot) => void>();
	private readonly persistence: AiraGoalPersistence;
	private persistenceRecord: AiraGoalPersistenceRecord = { status: "unavailable", error: undefined, path: undefined };
	private snapshot: AiraGoalSnapshot;
	private disposed = false;
	private unsubscribeAgent: (() => void) | undefined;
	private previousFailObservation:
		| { revisionId: string | undefined; blockingFinding: string | undefined; verdict: "fail" }
		| undefined = undefined;

	constructor(state: AiraSessionState, options: AiraGoalManagerOptions) {
		this.state = state;
		this.options = options;
		this.persistence =
			options.persistence ?? createAiraGoalPersistence(options.sessionId, options.startReason, { enabled: true });
		this.snapshot = this.buildIdleSnapshot();
		const recovered = this.persistence.recover();
		if (recovered) {
			this.goal = {
				id: recovered.id,
				objective: recovered.objective,
				status: recovered.status,
				round: recovered.round,
				createdAt: recovered.startedAt,
				startedAt: recovered.startedAt,
				updatedAt: recovered.updatedAt,
				completedAt: recovered.completedAt,
				stopReason: recovered.stopReason,
				waiting: recovered.waiting,
				revisionId: undefined,
				lastVerdict: recovered.lastVerdict,
				lastBlockingFinding: undefined,
				observedRound: recovered.round,
				usageBaseline: undefined,
				childUsageBaseline: undefined,
				childrenTokens: 0,
				verifierTokens: 0,
				lastResultId: undefined,
				lastRevisionId: undefined,
				continuationPending: false,
				evidenceAcquisitionRound: 0,
				repairContext: undefined,
				lastEvent:
					recovered.status === "paused" && recovered.stopReason === "interrupted"
						? "recovered after restart (running goal paused; resume explicitly)"
						: `recovered after restart (${recovered.status})`,
			};
			this.persistenceRecord = { status: "ok", error: undefined, path: this.persistence.path };
		}
	}

	/** Arm the service: subscribe to host agent events and publish state. */
	activate(): void {
		if (this.disposed) {
			return;
		}
		this.unsubscribeAgent = this.options.agentEvents((event) => this.applyAgentEvent(event));
		this.publish();
	}

	// -----------------------------------------------------------------------
	// User / lifecycle surface
	// -----------------------------------------------------------------------

	considerUserObjective(text: string): void {
		if (this.disposed) {
			return;
		}
		const current = this.goal;
		if (!current) {
			// SMART promotion: only real user prompts create goals.
			const decision = this.promotionDecision(text);
			if (decision.promote) {
				this.promote(text, decision.reason, undefined);
			}
			return;
		}
		if (current.status === "paused" || current.status === "waiting") {
			// A real user message resumes a stopped/waiting goal (steering,
			// constraint, or the input the goal was waiting for).
			this.transition(current, "active", "user message");
			current.stopReason = undefined;
			current.waiting = undefined;
			this.setEvent(current, "user message resumed the goal");
			this.persistGoal(current);
			return;
		}
		if (AIRA_GOAL_TERMINAL_STATUSES.includes(current.status)) {
			// The user moved on: a new objective replaces the terminal goal.
			const decision = this.promotionDecision(text);
			if (decision.promote) {
				this.promote(text, decision.reason, current);
			}
			return;
		}
		if (current.status === "active" || current.status === "repairing") {
			this.setEvent(current, "user steering message received");
		}
	}

	create(objective: string): AiraGoalActionResult {
		if (this.disposed) {
			return { ok: false, status: "error", message: "session disposed" };
		}
		if (!this.options.settings().enabled) {
			return { ok: false, status: "idle", message: "goals are disabled (goals.enabled=false)" };
		}
		const trimmed = objective.trim();
		if (trimmed.length === 0) {
			return { ok: false, status: "idle", message: "goal create requires an objective" };
		}
		const bounded = boundedText(trimmed, MAX_OBJECTIVE_CHARS);
		const current = this.goal;
		if (current && !AIRA_GOAL_TERMINAL_STATUSES.includes(current.status) && current.status !== "paused") {
			return {
				ok: false,
				status: current.status,
				message: `a goal is already ${current.status}; stop or cancel it first`,
			};
		}
		this.promote(bounded, "explicit /goal create", current);
		return { ok: true, status: "active", message: `goal started: ${boundedText(bounded, 120)}` };
	}

	stop(): AiraGoalActionResult {
		if (this.disposed) {
			return { ok: false, status: "error", message: "session disposed" };
		}
		const current = this.goal;
		if (!current) {
			return { ok: false, status: "idle", message: "no active goal" };
		}
		if (current.status === "paused") {
			return { ok: false, status: "paused", message: "goal is already paused" };
		}
		if (!AIRA_GOAL_RUNNING_STATUSES.includes(current.status) && current.status !== "waiting") {
			return { ok: false, status: current.status, message: `goal is ${current.status}` };
		}
		this.transition(current, "paused", "user stop");
		current.stopReason = "user";
		current.continuationPending = false;
		this.setEvent(current, "stopped by user (state preserved; /goal resume continues)");
		this.persistGoal(current);
		// Propagate into owned in-flight work: abort the current agent run
		// (never unrelated processes — execution/browser keep their own
		// ownership; the goal never kills what it does not own).
		this.options.abortRun?.();
		return { ok: true, status: "paused", message: "goal stopped (state preserved)" };
	}

	resume(): AiraGoalActionResult {
		if (this.disposed) {
			return { ok: false, status: "error", message: "session disposed" };
		}
		const current = this.goal;
		if (!current) {
			return { ok: false, status: "idle", message: "no goal to resume" };
		}
		if (current.status === "active" || current.status === "repairing") {
			return { ok: false, status: current.status, message: `goal is already ${current.status}` };
		}
		if (current.status === "completed") {
			return { ok: false, status: "completed", message: "goal is completed; /goal clear removes it" };
		}
		if (AIRA_GOAL_TERMINAL_STATUSES.includes(current.status)) {
			return {
				ok: false,
				status: current.status,
				message: `goal ended (${current.status}); /goal clear removes it`,
			};
		}
		this.transition(current, "active", "user resume");
		current.stopReason = undefined;
		current.waiting = undefined;
		this.setEvent(current, "resumed by user");
		this.persistGoal(current);
		this.publish();
		// After a FAIL-driven stop, resume continues the repair loop within
		// the same hard bounds (a fresh repair round, still counted).
		if (current.lastVerdict === "fail" && !current.continuationPending) {
			void this.enqueueRepair(current, "resumed");
		}
		return { ok: true, status: "active", message: "goal resumed" };
	}

	cancel(): AiraGoalActionResult {
		if (this.disposed) {
			return { ok: false, status: "error", message: "session disposed" };
		}
		const current = this.goal;
		if (!current || current.status === "idle") {
			return { ok: false, status: "idle", message: "no active goal" };
		}
		if (current.status === "cancelled") {
			return { ok: false, status: "cancelled", message: "goal is already cancelled" };
		}
		if (current.status === "completed") {
			return { ok: false, status: "completed", message: "goal is completed; /goal clear removes it" };
		}
		this.transition(current, "cancelled", "user cancel");
		current.stopReason = undefined;
		current.waiting = undefined;
		current.continuationPending = false;
		this.setEvent(current, "cancelled by user");
		this.persistGoal(current);
		// Propagate cancellation into owned work (the agent run in flight;
		// never unrelated resources).
		this.options.abortRun?.();
		return { ok: true, status: "cancelled", message: "goal cancelled" };
	}

	clear(): AiraGoalActionResult {
		if (this.disposed) {
			return { ok: false, status: "error", message: "session disposed" };
		}
		const current = this.goal;
		if (!current || current.status === "idle") {
			return { ok: false, status: "idle", message: "no goal state to clear" };
		}
		if (!AIRA_GOAL_CLEARABLE_STATUSES.includes(current.status)) {
			return {
				ok: false,
				status: current.status,
				message: `goal is ${current.status}; stop or cancel it before clearing`,
			};
		}
		this.setEvent(current, "cleared");
		this.goal = undefined;
		this.previousFailObservation = undefined;
		this.persistence.clear();
		this.publish();
		return { ok: true, status: "idle", message: "goal cleared" };
	}

	status(): AiraGoalSnapshot {
		this.publish();
		return this.snapshot;
	}

	subscribe(listener: (snapshot: AiraGoalSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// -----------------------------------------------------------------------
	// Host event seam
	// -----------------------------------------------------------------------

	applyAgentEvent(event: AgentEvent): void | Promise<void> {
		if (this.disposed) {
			return;
		}
		if (event.type === "message_start" && event.message.role === "user") {
			const text = messageText(event.message.content);
			this.considerUserObjective(text);
			return;
		}
		if (event.type === "agent_end") {
			return this.onAgentEnd(event);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.unsubscribeAgent?.();
		this.unsubscribeAgent = undefined;
		const current = this.goal;
		if (current && AIRA_GOAL_RUNNING_STATUSES.includes(current.status)) {
			this.transition(current, "paused", "session disposed");
			current.stopReason = "interrupted";
			current.continuationPending = false;
			this.setEvent(current, "session ended (goal paused; resume explicitly)");
			this.persistGoal(current);
		}
		this.listeners.clear();
		this.publish();
	}

	// -----------------------------------------------------------------------
	// Completion boundary
	// -----------------------------------------------------------------------

	private async onAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): Promise<void> {
		const current = this.goal;
		if (!current || !AIRA_GOAL_RUNNING_STATUSES.includes(current.status)) {
			return;
		}
		// The host enriches agent_end with its willRetry truth: a run the host
		// is about to retry is not a completed round.
		if ((event as Extract<AgentEvent, { type: "agent_end" }> & { willRetry?: boolean }).willRetry === true) {
			return;
		}
		const stopReason = lastAssistantStopReason(event.messages);
		if (stopReason === "aborted") {
			// User-initiated stop/cancel already moved the status; anything
			// else is an interruption → paused (never a silent reset).
			if (current.status === "paused" || current.status === "cancelled") {
				return;
			}
			this.transition(current, "paused", "run aborted");
			current.stopReason = "interrupted";
			current.continuationPending = false;
			this.setEvent(current, "implementation run interrupted (aborted)");
			this.persistGoal(current);
			return;
		}
		if (stopReason === "error") {
			this.transition(current, "paused", "run error");
			current.stopReason = "agent-error";
			current.continuationPending = false;
			this.setEvent(current, "implementation run ended with a model error");
			this.persistGoal(current);
			return;
		}
		current.continuationPending = false;
		current.updatedAt = this.now();
		await this.handleBoundary(current);
	}

	/**
	 * The completion boundary: refresh usage, obtain a fresh verification
	 * result, and act on PASS / FAIL / INCONCLUSIVE. Bounded by construction:
	 * hard budget checks, no-progress detection, and single evidence
	 * acquisition per round.
	 */
	private async handleBoundary(current: AiraGoalState): Promise<void> {
		if (current.status !== "active" && current.status !== "repairing") {
			return;
		}
		// Attribute child tokens produced since the last boundary before any
		// budget decision is made (truthful rounding of the ended round).
		this.commitChildUsage(current);

		// PLAN is genuinely read-only: no implementation, no verification, no
		// continuation. The goal tracks the objective truthfully.
		if (this.state.mode === "plan") {
			this.setEvent(current, "PLAN round: read-only; no verification or continuation");
			this.persistGoal(current);
			this.publish();
			return;
		}

		let result = this.freshVerificationResult(current);
		let boundaryNote: string | undefined;
		if (!result) {
			boundaryNote = await this.requestBoundaryVerification(current);
			result = this.freshVerificationResult(current);
		}
		if (!result) {
			// No verdict exists (and none could be produced): the goal cannot
			// establish completion; continuation must not fire. Normalize any
			// verifying status back to active so the next user turn drives the
			// next boundary (never a stuck state).
			if ((current.status as AiraGoalStatus) === "verifying") {
				this.transition(current, "active", "no verdict at boundary");
			}
			this.setEvent(current, boundaryNote ?? this.boundaryNoVerdictEvent());
			this.persistGoal(current);
			this.publish();
			return;
		}

		current.lastResultId = result.id;
		current.lastRevisionId = result.revisionId;
		current.revisionId = result.revisionId;
		current.lastVerdict = result.verdict;
		current.lastBlockingFinding = result.verdict === "fail" ? highestBlockingFinding(result) : undefined;
		current.observedRound = current.round;
		this.trackVerifierTokens(current, result);
		this.commitChildUsage(current);

		if (result.verdict === "pass") {
			current.repairContext = undefined;
			this.complete(current, result);
			return;
		}
		if (result.verdict === "fail") {
			current.repairContext = repairContextOf(result);
			await this.handleFail(current, result);
			return;
		}
		await this.handleInconclusive(current, result);
	}

	/**
	 * Request verification at the boundary (respects enabled/auto policy).
	 * Returns a bound event note when no verification could run.
	 */
	private async requestBoundaryVerification(current: AiraGoalState): Promise<string | undefined> {
		const verification = this.options.verification;
		if (!verification) {
			return "verification runtime unavailable — completion cannot be established";
		}
		const settings = this.state.verification;
		if (!settings || !settings.enabled) {
			this.setEvent(current, "verification disabled — completion cannot be established");
			return "verification disabled — completion cannot be established";
		}
		if (settings.auto === "off") {
			// auto=off means NO automatic verifier calls, including goal
			// boundaries; explicit /verify still produces a result the goal
			// consumes. Continuation never fires without a verdict.
			this.setEvent(current, "verification.auto=off — boundary awaits explicit /verify");
			this.publish();
			return "verification.auto=off — boundary awaits explicit /verify";
		}
		this.transition(current, "verifying", "completion boundary");
		this.setEvent(current, "independent verification at completion boundary");
		this.publish();
		try {
			await verification.verify();
		} finally {
			this.commitChildUsage(current);
		}
	}

	private async handleFail(current: AiraGoalState, result: AiraVerificationResult): Promise<void> {
		const observation = {
			revisionId: result.revisionId,
			blockingFinding: current.lastBlockingFinding,
			verdict: "fail" as const,
		};
		if (this.previousFailObservation) {
			if (isNoProgress(this.previousFailObservation, observation)) {
				this.budgetLimit(current, {
					reason: "no-progress",
					detail: "consecutive rounds produced the same implementation state and blocking finding",
				});
				return;
			}
			if (isRepeatedVerdict(this.previousFailObservation, observation)) {
				this.budgetLimit(current, {
					reason: "repeated-verdict",
					detail: "consecutive rounds produced an identical FAIL verdict",
				});
				return;
			}
		}
		this.previousFailObservation = observation;
		this.persistGoal(current);
		await this.enqueueRepair(current, "verification FAIL");
	}

	private async handleInconclusive(current: AiraGoalState, result: AiraVerificationResult): Promise<void> {
		const acquisition = this.evidenceAcquisitionPlan(result);
		if (acquisition.kind === "run-tests" && current.evidenceAcquisitionRound !== current.round) {
			const bound = budgetBoundVerdict(this.options.settings(), {
				round: current.round - 1, // evidence re-checking is not an implementation round
				startedAt: current.startedAt,
				now: this.now(),
				usage: this.usageProjection(current),
			});
			// Only token/duration bounds gate evidence acquisition; max-rounds
			// governs implementation rounds, never re-verification.
			if (bound && bound.reason !== "max-rounds") {
				this.budgetLimit(current, bound);
				return;
			}
			current.evidenceAcquisitionRound = current.round;
			this.setEvent(current, "INCONCLUSIVE — acquiring missing evidence (bounded test run)");
			this.publish();
			const ran = await this.acquireTestEvidence(acquisition.command);
			if (ran) {
				const recheck = await this.options.verification?.verify({ force: true });
				if (recheck?.ok) {
					const fresh = this.freshVerificationResult(current);
					if (fresh && fresh.id !== result.id) {
						current.lastResultId = fresh.id;
						current.lastRevisionId = fresh.revisionId;
						current.revisionId = fresh.revisionId;
						current.lastVerdict = fresh.verdict;
						current.lastBlockingFinding = fresh.verdict === "fail" ? highestBlockingFinding(fresh) : undefined;
						current.observedRound = current.round;
						this.trackVerifierTokens(current, fresh);
						this.commitChildUsage(current);
						if (fresh.verdict === "pass") {
							current.repairContext = undefined;
							this.complete(current, fresh);
							return;
						}
						if (fresh.verdict === "fail") {
							current.repairContext = repairContextOf(fresh);
							await this.handleFail(current, fresh);
							return;
						}
					}
				}
			}
			// Still inconclusive after bounded acquisition → truthful waiting.
			this.enterWaiting(
				current,
				"missing-evidence",
				`missing evidence could not be fully acquired: ${summarizeMissingEvidence(result.missingEvidence)}`,
				result.missingEvidence[0],
			);
			return;
		}
		// Not safely acquirable: structured waiting (INCONCLUSIVE never
		// becomes PASS silently; never guessed).
		const requiresInput =
			/(choose|choice|decide|decision|approve|approval|confirm|credential|api key|ambiguous|which approach|clarif)/i.test(
				result.missingEvidence.join(" "),
			);
		this.enterWaiting(
			current,
			requiresInput ? "input-required" : "missing-evidence",
			`INCONCLUSIVE: ${summarizeMissingEvidence(result.missingEvidence)}`,
			result.missingEvidence[0],
		);
	}

	/** What missing evidence can be safely acquired this round (bounded). */
	private evidenceAcquisitionPlan(
		result: AiraVerificationResult,
	): { kind: "none" } | { kind: "run-tests"; command: string } {
		if (result.missingEvidence.length === 0) {
			return { kind: "none" };
		}
		const wantsTests = result.missingEvidence.some((item) => /(test|suite|run|execute|build|check)/i.test(item));
		const testCommand = firstOf(this.state.project?.testCommands) ?? firstOf(this.state.project?.checkCommands);
		if (wantsTests && testCommand && this.options.execution) {
			return { kind: "run-tests", command: testCommand };
		}
		// Browser-class missing evidence is NOT auto-acquired here: the
		// browser runtime's own auto-verify (browser.autoVerify) already
		// produces bounded checks when enabled and relevant; the goal never
		// forces browser use when disabled/unavailable (waits truthfully).
		return { kind: "none" };
	}

	private async acquireTestEvidence(command: string): Promise<boolean> {
		const execution = this.options.execution;
		if (!execution) {
			return false;
		}
		try {
			const outcome = await execution.start(
				{ command, cwd: this.options.cwd },
				{ purpose: "test", timeoutMs: MAX_ACQUISITION_TIMEOUT_MS },
			);
			return outcome.ok || outcome.status !== "spawn-failed";
		} catch {
			return false;
		}
	}

	private async enqueueRepair(current: AiraGoalState, cause: string): Promise<void> {
		if (current.status !== "repairing" && current.status !== "active" && current.status !== "verifying") {
			return;
		}
		if (this.options.hasPendingMessages?.()) {
			// User steering wins: defer the repair continuation (the queued
			// user turn becomes the next round). Never a stuck state.
			if ((current.status as AiraGoalStatus) === "verifying") {
				this.transition(current, "active", "continuation deferred to user turn");
			}
			this.setEvent(current, "user message pending — repair continuation deferred");
			this.persistGoal(current);
			this.publish();
			return;
		}
		if (!this.options.sendContinuation) {
			// Hosts without a continuation seam: the goal halts truthfully
			// instead of pretending autonomy (documented limitation); the next
			// explicit user turn drives the next round.
			if ((current.status as AiraGoalStatus) === "verifying") {
				this.transition(current, "active", "no continuation seam");
			}
			this.setEvent(current, "no continuation seam — awaiting an explicit user turn");
			this.persistGoal(current);
			this.publish();
			return;
		}
		const nextRound = current.round + 1;
		const bound = budgetBoundVerdict(this.options.settings(), {
			round: nextRound,
			startedAt: current.startedAt,
			now: this.now(),
			usage: this.usageProjection(current),
		});
		if (bound) {
			this.budgetLimit(current, bound);
			return;
		}
		const repairContext = current.repairContext ?? repairContextOf(this.freshVerificationResult(current));
		if (!repairContext) {
			return;
		}
		this.transition(current, "repairing", cause);
		current.round = nextRound;
		const prompt = buildAiraGoalContinuationPrompt({
			objective: current.objective,
			round: current.round,
			repair: repairContext,
			changeContext: this.changeContextLine(),
		});
		this.setEvent(current, `verification FAIL → repair round ${current.round}`);
		this.publish();
		this.persistGoal(current);
		const sent = await this.options.sendContinuation(prompt);
		current.continuationPending = sent;
		if (!sent) {
			this.setEvent(current, "continuation could not be sent — awaiting next user turn");
			this.persistGoal(current);
		}
		this.publish();
	}

	private complete(current: AiraGoalState, result: AiraVerificationResult): void {
		this.transition(current, "completed", "verification PASS");
		current.completedAt = this.now();
		current.stopReason = undefined;
		current.waiting = undefined;
		this.setEvent(current, "verification PASS — goal completed");
		this.persistGoal(current);
		this.publish();
	}

	private budgetLimit(
		current: AiraGoalState,
		bound: {
			reason: Extract<
				AiraGoalStopReason,
				"max-rounds" | "token-budget" | "max-duration" | "no-progress" | "repeated-verdict"
			>;
			detail: string;
		},
	): void {
		this.transition(current, "budget-limited", "continuation bound");
		current.stopReason = bound.reason;
		this.setEvent(current, `continuation stopped: ${bound.reason}`);
		this.persistGoal(current);
		this.publish();
	}

	private enterWaiting(
		current: AiraGoalState,
		reason: Extract<AiraGoalStopReason, "input-required" | "missing-evidence">,
		detail: string,
		firstMissing: string | undefined,
	): void {
		this.transition(current, "waiting", "goal waits");
		current.stopReason = reason;
		current.waiting = {
			reason,
			detail: boundedText(detail, MAX_WAITING_DETAIL_CHARS),
			...(reason === "input-required" && firstMissing ? { ask: boundedText(firstMissing, 200) } : {}),
		};
		this.setEvent(current, `waiting: ${reason}`);
		this.persistGoal(current);
		this.publish();
	}

	// -----------------------------------------------------------------------
	// Promotion / state helpers
	// -----------------------------------------------------------------------

	private promotionDecision(text: string): { promote: boolean; reason: string } {
		const settings = this.options.settings();
		if (!settings.enabled) {
			return { promote: false, reason: "goals.enabled is false" };
		}
		return decideAiraGoalPromotion(settings.auto, text);
	}

	private promote(objective: string, reason: string, previous: AiraGoalState | undefined): void {
		const now = this.now();
		if (previous) {
			this.setEvent(previous, `replaced by a new objective (${reason})`);
		}
		this.goal = {
			id: `g-${now.toString(36)}-${randomUUID().slice(0, 6)}`,
			objective: boundedText(objective, MAX_OBJECTIVE_CHARS),
			status: "active",
			round: 1,
			createdAt: now,
			startedAt: now,
			updatedAt: now,
			completedAt: undefined,
			stopReason: undefined,
			waiting: undefined,
			revisionId: undefined,
			lastVerdict: undefined,
			lastBlockingFinding: undefined,
			observedRound: 0,
			usageBaseline: this.options.usageSeam?.(),
			childUsageBaseline: this.state.orchestration?.aggregateTokenUsage,
			childrenTokens: 0,
			verifierTokens: 0,
			lastResultId: undefined,
			lastRevisionId: undefined,
			continuationPending: false,
			evidenceAcquisitionRound: 0,
			repairContext: undefined,
			lastEvent: `goal started (${reason}) — round 1`,
		};
		this.previousFailObservation = undefined;
		this.persistGoal(this.goal);
		this.publish();
	}

	private transition(current: AiraGoalState, to: AiraGoalStatus, context: string): void {
		assertAiraGoalTransition(current.status, to, context);
		current.status = to;
		current.updatedAt = this.now();
	}

	private setEvent(current: AiraGoalState, event: string): void {
		current.lastEvent = boundedText(event, MAX_LAST_EVENT_CHARS);
		current.updatedAt = this.now();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	// -----------------------------------------------------------------------
	// Usage / freshness
	// -----------------------------------------------------------------------

	/**
	 * Advance the child-usage baseline to the current aggregate, attributing
	 * the delta since the last boundary to the goal (monotonic; never loses
	 * children work that happened between boundaries).
	 */
	private commitChildUsage(current: AiraGoalState): void {
		const children = this.state.orchestration?.aggregateTokenUsage;
		if (children) {
			const delta = Math.max(0, children.total - (current.childUsageBaseline?.total ?? 0));
			current.childrenTokens += delta;
			current.childUsageBaseline = mergeAiraChildTokenUsage(current.childUsageBaseline, children);
		}
	}

	private trackVerifierTokens(current: AiraGoalState, result: AiraVerificationResult): void {
		if (result.tokenUsage && result.tokenUsage.total > 0) {
			current.verifierTokens += result.tokenUsage.total;
		}
	}

	private usageProjection(current: AiraGoalState): AiraGoalUsage {
		const usage = computeAiraGoalUsage({
			session: this.options.usageSeam?.(),
			baseline: current.usageBaseline,
			children: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: current.childrenTokens },
			childrenBaseline: undefined,
			verifierTokens: current.verifierTokens,
		});
		return usage;
	}

	private freshVerificationResult(current: AiraGoalState): AiraVerificationResult | undefined {
		const result = this.state.verification?.currentResult;
		if (!result) {
			return undefined;
		}
		// Fresh when the result is new (id) OR the verified revision moved
		// (an unchanged revision with a consumed result is not re-consumed).
		if (result.id === current.lastResultId && result.revisionId === current.lastRevisionId) {
			return undefined;
		}
		return result;
	}

	// -----------------------------------------------------------------------
	// Snapshot
	// -----------------------------------------------------------------------

	private buildIdleSnapshot(): AiraGoalSnapshot {
		const settings = this.options.settings();
		return {
			enabled: settings.enabled,
			auto: settings.auto,
			status: "idle",
			id: undefined,
			objective: undefined,
			round: 0,
			maxRounds: settings.maxRounds,
			startedAt: undefined,
			updatedAt: this.now(),
			completedAt: undefined,
			stopReason: undefined,
			waiting: undefined,
			budget: { tokens: settings.tokenBudget, maxDurationMs: settings.maxDurationMs },
			usage: { sources: [] },
			revision: undefined,
			tasks: this.taskProjection(),
			verification: this.verificationProjection(),
			staleCompletion: false,
			needsUserInput: false,
			mode: this.state.mode,
			lastEvent: undefined,
			persistence: {
				enabled: true,
				status: this.persistenceRecord.status,
				path: this.persistenceRecord.path,
				error: this.persistenceRecord.error,
			},
			summary: "idle",
		};
	}

	private publish(): void {
		const snapshot = this.buildSnapshot();
		this.snapshot = snapshot;
		this.state.goal = snapshot;
		for (const listener of [...this.listeners]) {
			listener(snapshot);
		}
	}

	private buildSnapshot(): AiraGoalSnapshot {
		const settings = this.options.settings();
		const current = this.goal;
		if (!current) {
			return this.buildIdleSnapshot();
		}
		const usage = this.usageProjection(current);
		const verification = this.verificationProjection();
		// Stale-completion truth: a completed goal whose verified revision
		// moved is no longer fresh (derived from the Phase 8 snapshot — the
		// goal never owns a competing freshness store).
		const staleCompletion = current.status === "completed" && (verification.stale || verification.verdict !== "pass");
		const remaining =
			settings.tokenBudget !== undefined && usage.consumedTokens !== undefined
				? Math.max(0, settings.tokenBudget - usage.consumedTokens)
				: undefined;
		const tasks = this.taskProjection();
		return {
			enabled: settings.enabled,
			auto: settings.auto,
			status: current.status,
			id: current.id,
			objective: boundedText(current.objective, MAX_OBJECTIVE_SNAPSHOT_CHARS),
			round: current.round,
			maxRounds: settings.maxRounds,
			startedAt: current.startedAt,
			updatedAt: current.updatedAt,
			completedAt: current.completedAt,
			stopReason: current.stopReason,
			waiting: current.waiting,
			budget: { tokens: settings.tokenBudget, maxDurationMs: settings.maxDurationMs },
			usage: { ...usage, remainingTokens: remaining },
			revision:
				current.revisionId !== undefined
					? {
							revisionId: current.revisionId,
							round: current.observedRound,
							blockingSignature: blockingSignatureOf(current.lastBlockingFinding),
						}
					: undefined,
			tasks,
			verification,
			staleCompletion,
			needsUserInput: current.status === "waiting",
			mode: this.state.mode,
			lastEvent: current.lastEvent,
			persistence: {
				enabled: true,
				status: this.persistenceRecord.status,
				path: this.persistenceRecord.path,
				error: this.persistenceRecord.error,
			},
			summary: summarizeGoal(this, current, tasks, verification),
		};
	}

	private taskProjection(): AiraGoalTaskProjection {
		const orchestration = this.state.orchestration;
		if (!orchestration) {
			return { completed: 0, active: 0 };
		}
		return {
			completed: (orchestration.children ?? []).filter((child) => child.phase === "settled").length,
			active: (orchestration.runningCount ?? 0) + (orchestration.queuedCount ?? 0),
		};
	}

	private verificationProjection(): AiraGoalVerificationProjection {
		const verification = this.state.verification;
		const result = verification?.currentResult;
		return {
			verdict: result?.verdict,
			stale: verification?.stale ?? false,
			summary: result ? boundedText(result.summary, 300) : undefined,
			missingEvidence: (verification?.missingEvidence ?? [])
				.slice(0, MAX_MISSING_EVIDENCE_SNAPSHOT)
				.map((item) => boundedText(item, MAX_MISSING_EVIDENCE_CHARS)),
			lastError: verification?.lastError,
		};
	}

	private persistGoal(current: AiraGoalState): void {
		if (!current) {
			return;
		}
		this.persistenceRecord = this.persistence.save({
			id: current.id,
			objective: current.objective,
			status: current.status,
			round: current.round,
			startedAt: current.startedAt,
			updatedAt: current.updatedAt,
			completedAt: current.completedAt,
			stopReason: current.stopReason,
			waiting: current.waiting,
			lastVerdict: current.lastVerdict,
			sessionTokens: this.usageProjection(current).sessionTokens,
		});
	}

	private changeContextLine(): string {
		const revision = this.state.verification?.currentResult;
		if (revision) {
			const changed = revision.evidence
				.slice(0, 4)
				.map((item) => item.label)
				.join(", ");
			return `revision ${revision.revisionId.slice(0, 8)}${changed ? ` · verifier evidence: ${changed}` : ""}`;
		}
		const findings = this.state.intelligence?.findings;
		return findings ? `${findings.errors} errors / ${findings.warnings} warnings` : "";
	}

	private boundaryNoVerdictEvent(): string {
		return "no fresh verification verdict — awaiting explicit verification or user turn";
	}
}

/** Create the session's goal manager and return the handle. */
export function createAiraGoalManager(state: AiraSessionState, options: AiraGoalManagerOptions): AiraGoalHandle {
	const manager = new AiraGoalManager(state, options);
	manager.activate();
	return manager;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function summarizeGoal(
	manager: AiraGoalManager,
	current: AiraGoalState,
	tasks: AiraGoalTaskProjection,
	verification: AiraGoalVerificationProjection,
): string {
	switch (current.status) {
		case "active":
			return `active · round ${current.round}${tasks.active > 0 ? ` · ${tasks.completed}/${tasks.completed + tasks.active} tasks` : ""}`;
		case "repairing":
			return `repairing · round ${current.round}`;
		case "verifying":
			return "verifying";
		case "waiting":
			return current.waiting?.reason === "input-required" ? "waiting · input required" : "waiting";
		case "paused":
			return "paused";
		case "completed":
			return verification.stale ? "completed (verification stale)" : "completed";
		case "budget-limited":
			return `budget-limited · ${current.stopReason ?? "bound"}`;
		case "cancelled":
			return "cancelled";
		case "error":
			return "error";
		case "idle":
			return "idle";
	}
}

function highestBlockingFinding(result: AiraVerificationResult): string | undefined {
	const blocking = result.findings.filter((finding) => finding.severity === "blocking");
	if (blocking.length === 0) {
		return undefined;
	}
	return boundedText(blocking[0].message, 240);
}

function blockingSignatureOf(finding: string | undefined): string | undefined {
	if (!finding) {
		return undefined;
	}
	return `${finding.length}:${finding}`;
}

function repairContextOf(result: AiraVerificationResult | undefined): AiraGoalRepairContext | undefined {
	if (!result) {
		return undefined;
	}
	return {
		summary: boundedText(result.summary, 300),
		blocking: result.findings
			.filter((finding) => finding.severity === "blocking")
			.slice(0, 5)
			.map((finding) =>
				boundedText(finding.evidence ? `${finding.message} (${finding.evidence})` : finding.message, 320),
			),
		unmet: result.requirements
			.filter((requirement) => requirement.status === "unmet")
			.slice(0, 8)
			.map((requirement) => `${requirement.id}: ${boundedText(requirement.text, 180)}`),
		evidence: result.evidence.slice(0, 8).map((item) => item.label),
	};
}

function firstOf(values: readonly string[] | undefined): string | undefined {
	return values && values.length > 0 ? values[0] : undefined;
}

function lastAssistantStopReason(messages: unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") {
			continue;
		}
		const record = message as { role?: unknown; stopReason?: unknown };
		if (record.role !== "assistant") {
			continue;
		}
		return typeof record.stopReason === "string" ? record.stopReason : undefined;
	}
	return undefined;
}

function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		const record = block as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") {
			parts.push(record.text);
		}
	}
	return parts.join("\n").trim();
}

function boundedText(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 1)}…`;
}

function summarizeMissingEvidence(items: readonly string[]): string {
	if (items.length === 0) {
		return "no specific missing evidence listed";
	}
	const joined = items.slice(0, 3).join("; ");
	return joined.length <= 240 ? joined : `${joined.slice(0, 239)}…`;
}
