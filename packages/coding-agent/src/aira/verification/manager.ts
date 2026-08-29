/**
 * Aira verification — manager.
 *
 * The per-session owner of independent verification (ADR-026): decides when
 * automatic verification runs (agent_end completion boundary, settings
 * policy, trivial-work skip, revision dedupe), collects the bounded evidence
 * bundle from canonical snapshots, invokes the fresh-context verifier, and
 * publishes the canonical `state.verification` snapshot. Freshness is
 * enforced both event-driven (a new edit invalidates the prior result) and
 * on refresh (mtime drift of the verified change set). INCONCLUSIVE is never
 * upgraded; verifier driver failures surface as INCONCLUSIVE with an
 * explicit `lastError`, never as PASS. No repair loop exists here: a FAIL
 * result is a transition a later orchestrator may consume.
 */
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AiraSessionState } from "../state.ts";
import { type AiraChangeFile, decideAutomaticVerification } from "./eligibility.ts";
import { boundedText, buildVerificationEvidence } from "./evidence.ts";
import { buildVerifierEnvelope } from "./prompt.ts";
import { countRequirementStatuses } from "./requirements.ts";
import type { AiraVerificationSettings } from "./settings.ts";
import type {
	AiraVerificationResult,
	AiraVerificationStatus,
	AiraVerificationStatusState,
	AiraVerificationVerdict,
} from "./types.ts";
import { initialAiraVerificationStatus } from "./types.ts";
import type { AiraVerifierOutcome, AiraVerifierRuntime } from "./verifier.ts";
import { runAiraVerifier } from "./verifier.ts";

const MTIME_DRIFT_TOLERANCE_MS = 50;
const MAX_CHANGE_SET_FILES = 200;
const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_EDITED_PATHS = 200;

export interface AiraVerificationManagerOptions {
	/** Session working directory (scope for the verifier's read-only tools). */
	cwd: string;
	/** Canonical settings accessor (live — mode changes take effect immediately). */
	settings: () => AiraVerificationSettings;
	/** Repository change seam (bounded per-file git change stats; undefined when unavailable). */
	changeSeam?: () => Promise<AiraChangeFile[] | undefined>;
	/** Verifier model runtime resolver (undefined = unavailable → INCONCLUSIVE). */
	runtime?: () => Promise<AiraVerifierRuntime | undefined>;
	/** Runner seam (unit tests inject canned outcomes). */
	runner?: (
		runtime: AiraVerifierRuntime,
		options: { cwd: string; envelope: string; timeoutMs: number },
		signal?: AbortSignal,
	) => Promise<AiraVerifierOutcome>;
	/** Verifier model-call timeout. */
	timeoutMs?: number;
	/** Max evidence envelope budget class override (tests). */
	maxChangeSetFiles?: number;
}

/** Result of requesting a verification run. */
export interface AiraVerifyRequestResult {
	ok: boolean;
	/** "ran" | "reused" | "skipped" | "held" | "disabled" | "refused" | "failed". */
	outcome: "ran" | "reused" | "skipped" | "held" | "disabled" | "refused" | "failed";
	reason?: string;
	result?: AiraVerificationResult;
}

export interface AiraVerificationHandle {
	/** Run independent verification now (explicit path; REVIEW-friendly). */
	verify(options?: { force?: boolean }): Promise<AiraVerifyRequestResult>;
	/** Canonical snapshot (refreshes staleness first, bounded). */
	status(): AiraVerificationStatus;
	/** Status listener seam (token-free UI projection). */
	subscribe(listener: (status: AiraVerificationStatus) => void): () => void;
	/** Feed host agent events (subscription seam). */
	applyAgentEvent(event: AgentEvent): void;
	dispose(): Promise<void>;
}

interface RunScope {
	edits: Map<string, AiraChangeFile>;
	executionBaseline: number;
	browserWork: boolean;
	objective: string | undefined;
	active: boolean;
}

export class AiraVerificationManager implements AiraVerificationHandle {
	private readonly state: AiraSessionState;
	private readonly agentEvents: (listener: (event: AgentEvent) => void) => () => void;
	private readonly options: Required<Pick<AiraVerificationManagerOptions, "cwd" | "settings">> &
		AiraVerificationManagerOptions;
	private snapshot: AiraVerificationStatus;
	private readonly listeners = new Set<(status: AiraVerificationStatus) => void>();
	private runScope: RunScope = {
		edits: new Map(),
		executionBaseline: 0,
		browserWork: false,
		objective: undefined,
		active: false,
	};
	private pendingEditPaths = new Map<string, string>();
	private lastChangeFiles: AiraChangeFile[] = [];
	private lastObjective = "";
	private abort: AbortController | undefined;
	private inFlight = false;
	private disposed = false;
	private runCounter = 0;

	constructor(
		state: AiraSessionState,
		agentEvents: (listener: (event: AgentEvent) => void) => () => void,
		options: AiraVerificationManagerOptions,
	) {
		this.state = state;
		this.agentEvents = agentEvents;
		this.options = options;
		this.snapshot = initialAiraVerificationStatus(options.settings());
	}

	/** Arm the service: subscribe to host agent events and publish state. */
	activate(): void {
		if (this.disposed) {
			return;
		}
		this.agentEvents((event) => this.applyAgentEvent(event));
		this.publish();
	}

	/**
	 * Explicit verification request (`/verify`): run now unless the same
	 * unchanged revision already has a current result (dedupe), or hold while
	 * another run is in flight.
	 */
	async verify(options: { force?: boolean } = {}): Promise<AiraVerifyRequestResult> {
		if (this.disposed) {
			return { ok: false, outcome: "refused", reason: "session disposed" };
		}
		if (!this.options.settings().enabled) {
			return { ok: false, outcome: "disabled", reason: "verification is disabled (verification.enabled=false)" };
		}
		if (this.inFlight) {
			return { ok: false, outcome: "held", reason: "verification already running" };
		}
		const files = await this.collectChangeFiles();
		if (files.length === 0) {
			return { ok: false, outcome: "skipped", reason: "nothing to verify (no changed files)" };
		}
		const revisionId = computeRevisionId(files, this.options.cwd);
		if (
			!options.force &&
			this.snapshot.currentResult &&
			this.snapshot.currentResult.revisionId === revisionId &&
			!this.snapshot.currentResult.stale
		) {
			return {
				ok: true,
				outcome: "reused",
				reason: "unchanged revision already verified",
				result: this.snapshot.currentResult,
			};
		}
		const objective = this.lastObjective || "(explicit verification request)";
		return this.runVerification(files, revisionId, objective, this.state.mode);
	}

	/** Current canonical snapshot (staleness-refreshed, bounded). */
	status(): AiraVerificationStatus {
		this.refreshStaleness();
		return this.snapshot;
	}

	subscribe(listener: (status: AiraVerificationStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	applyAgentEvent(event: AgentEvent): void {
		if (this.disposed) {
			return;
		}
		if (event.type === "turn_start") {
			if (!this.runScope.active) {
				// The scope spans the whole agent run (a run can contain several
				// provider turns: tool call → next request → … → agent_end). Starting
				// a fresh scope only when the previous run ended keeps edits made in
				// earlier turns of the same run.
				this.runScope = {
					edits: new Map(),
					executionBaseline: this.state.execution?.recentResults.length ?? 0,
					browserWork: false,
					objective: undefined,
					active: true,
				};
			}
			return;
		}
		if (
			this.runScope.active &&
			event.type === "tool_execution_start" &&
			(event.toolName === "edit" || event.toolName === "write")
		) {
			const path = toolPath(event.args);
			if (path) {
				this.pendingEditPaths.set(event.toolCallId, path);
			}
			return;
		}
		if (this.runScope.active && event.type === "tool_execution_end") {
			if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
				const path = this.pendingEditPaths.get(event.toolCallId);
				this.pendingEditPaths.delete(event.toolCallId);
				if (path) {
					this.recordEdit(path);
				}
				// A new relevant edit invalidates any prior verification result.
				this.invalidateResult("new edit after the verification result");
				return;
			}
			if (event.toolName.startsWith("browser_")) {
				this.runScope.browserWork = true;
			}
		}
		if (event.type === "agent_end") {
			void this.onAgentEnd(event.messages);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.abort?.abort();
		this.abort = undefined;
		this.listeners.clear();
		this.publish();
	}

	private recordEdit(path: string): void {
		const rel = toRelative(this.options.cwd, path);
		if (!rel) {
			return;
		}
		const existing = this.runScope.edits.get(rel);
		this.runScope.edits.set(rel, { path: rel, status: existing?.status ?? "modified", added: 0, deleted: 0 });
	}

	/** Invalidate the current result when relevant state moved (event driven). */
	private invalidateResult(reason: string): void {
		const result = this.snapshot.currentResult;
		if (result && !result.stale) {
			result.stale = true;
			result.staleReason = reason;
			this.publish();
		}
	}

	/** Bounded mtime drift check over the verified change set. */
	private refreshStaleness(): void {
		const result = this.snapshot.currentResult;
		if (!result || result.stale) {
			return;
		}
		const files = this.lastChangeFiles;
		if (files.length === 0) {
			return;
		}
		for (const file of files) {
			const mtime = fileMtimeMs(join(this.options.cwd, file.path));
			if (mtime === undefined || mtime > result.completedAt + MTIME_DRIFT_TOLERANCE_MS) {
				result.stale = true;
				result.staleReason =
					mtime === undefined
						? `changed file removed: ${file.path}`
						: `changed file edited after verification: ${file.path}`;
				break;
			}
		}
		if (result.stale) {
			this.publish();
		}
	}

	private async collectChangeFiles(): Promise<AiraChangeFile[]> {
		const seamFiles = await this.options.changeSeam?.();
		const merged = new Map<string, AiraChangeFile>();
		for (const file of seamFiles ?? []) {
			if (merged.size >= (this.options.maxChangeSetFiles ?? MAX_CHANGE_SET_FILES)) {
				break;
			}
			merged.set(file.path, file);
		}
		for (const rel of this.runScope.edits.keys()) {
			if (merged.size >= (this.options.maxChangeSetFiles ?? MAX_CHANGE_SET_FILES)) {
				break;
			}
			if (!merged.has(rel)) {
				merged.set(rel, { path: rel, status: "modified", added: 0, deleted: 0 });
			}
		}
		return [...merged.values()];
	}

	private async onAgentEnd(messages: unknown[]): Promise<void> {
		if (this.disposed || this.state.runtime !== "active") {
			return;
		}
		const settings = this.options.settings();
		if (!settings.enabled || settings.auto === "off") {
			return;
		}
		if (this.state.mode === "plan") {
			// Auto verification never fires in PLAN (implementation cannot occur);
			// explicit /verify remains available (read-only construction).
			this.snapshot.lastSkipReason = "plan mode (no automatic verification)";
			this.publish();
			return;
		}
		if (this.inFlight) {
			// A verification run is in flight; the ended run's completion will be
			// re-evaluated at the next boundary (dedupe protects repeat runs).
			return;
		}
		const objective = lastUserMessageText(messages, MAX_OBJECTIVE_CHARS);
		if (objective) {
			this.lastObjective = objective;
		}
		this.runScope.active = false;

		const files = await this.collectChangeFiles();

		// Freshness first: if the verified change set moved, the prior result is
		// stale regardless of what this run did.
		if (this.snapshot.currentResult && changeSetChanged(files, this.lastChangeFiles)) {
			this.invalidateResult("change set moved after the verification result");
		}

		// Dedupe: an unchanged implementation revision with a current result is
		// not reverified (no duplicate verifier runs for the same revision).
		const revisionId = computeRevisionId(files, this.options.cwd);
		if (
			this.snapshot.currentResult &&
			this.snapshot.currentResult.revisionId === revisionId &&
			!this.snapshot.currentResult.stale
		) {
			this.snapshot.lastSkipReason = "unchanged revision already verified";
			this.publish();
			return;
		}

		const executionDelta = (this.state.execution?.recentResults.length ?? 0) - this.runScope.executionBaseline;
		const workHappened = this.runScope.edits.size > 0 || executionDelta > 0 || this.runScope.browserWork;
		const decision = decideAutomaticVerification(
			settings.auto,
			workHappened,
			files,
			diagnosticsClean(this.state.intelligence),
		);
		if (!decision.run) {
			this.snapshot.lastSkipReason = decision.reason;
			this.publish();
			return;
		}

		await this.runVerification(files, revisionId, objective ?? this.lastObjective, this.state.mode);
	}

	private async runVerification(
		files: AiraChangeFile[],
		revisionId: string,
		objective: string,
		mode: AiraSessionState["mode"],
	): Promise<AiraVerifyRequestResult> {
		if (this.inFlight) {
			return { ok: false, outcome: "held", reason: "verification already running" };
		}
		this.inFlight = true;
		this.lastChangeFiles = files;
		this.runCounter += 1;
		const startedAt = Date.now();
		this.snapshot = {
			...this.snapshot,
			status: "preparing",
			lastError: undefined,
			lastSkipReason: undefined,
			startedAt,
			updatedAt: startedAt,
		};
		this.publish();

		const bundle = buildVerificationEvidence({
			objective: boundedText(objective, MAX_OBJECTIVE_CHARS),
			mode,
			changeFiles: files.length > 0 ? files : undefined,
			editedPaths: [...this.runScope.edits.keys()].slice(0, MAX_EDITED_PATHS),
			intelligence: this.state.intelligence,
			execution: this.state.execution,
			browser: this.state.browser,
			contextBudget: this.options.settings().contextBudget,
		});
		const envelope = buildVerifierEnvelope(bundle);

		this.snapshot = { ...this.snapshot, status: "running", updatedAt: Date.now() };
		this.publish();

		try {
			const runtime = await this.options.runtime?.();
			if (!runtime?.model) {
				this.failRun("verifier model unavailable (no model/auth configured)");
				this.inFlight = false;
				return { ok: false, outcome: "failed", reason: "verifier model unavailable" };
			}
			const timeoutMs = this.options.timeoutMs ?? 180_000;
			this.abort = new AbortController();
			const signal = this.abort.signal;
			const outcome = await (this.options.runner
				? this.options.runner(runtime, { cwd: this.options.cwd, envelope, timeoutMs }, signal)
				: runAiraVerifier(runtime, { cwd: this.options.cwd, envelope, timeoutMs }, signal));
			this.abort = undefined;
			const completedAt = Date.now();
			if (!outcome.ok) {
				this.failRun(outcome.driverError);
				this.inFlight = false;
				return { ok: false, outcome: "failed", reason: outcome.driverError };
			}
			const verdict = outcome.verdict;
			const result: AiraVerificationResult = {
				id: verifierResultId(this.runCounter),
				revisionId,
				verdict: verdict.verdict,
				summary: verdict.summary,
				mode,
				objective: boundedText(objective, MAX_OBJECTIVE_CHARS),
				requirements: verdict.requirements,
				findings: verdict.findings,
				evidence: verdict.evidence,
				missingEvidence: verdict.missingEvidence,
				scopeAssessment: verdict.scopeAssessment,
				confidence: verdict.confidence,
				startedAt,
				completedAt,
				stale: false,
			};
			// Completion fence: if the implementation moved while the verifier
			// was running, the result is already stale (never presented as fresh).
			const driftedFiles = await this.collectChangeFiles();
			const revisionAfter = computeRevisionId(driftedFiles, this.options.cwd);
			if (revisionAfter !== revisionId) {
				result.stale = true;
				result.staleReason = "change set moved while verification was running";
			}
			const counts = countRequirementStatuses(result.requirements);
			this.snapshot = {
				...this.snapshot,
				status: verdictState(result.verdict),
				currentResult: result,
				requirementsTotal: counts.total,
				requirementsVerified: counts.verified,
				highestFinding: highestFinding(result.findings),
				missingEvidence: result.missingEvidence,
				lastError: undefined,
				completedAt,
				updatedAt: completedAt,
			};
			this.publish();
			return { ok: true, outcome: "ran", result };
		} catch (error) {
			this.abort = undefined;
			this.failRun(error instanceof Error ? error.message : String(error));
			return { ok: false, outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
		} finally {
			this.inFlight = false;
		}
	}

	private failRun(reason: string): void {
		this.snapshot = {
			...this.snapshot,
			status: "inconclusive",
			lastError: reason,
			completedAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.publish();
	}

	private publish(): void {
		this.snapshot.updatedAt = Date.now();
		// The snapshot's stale flag is derived from the current result so the
		// two can never drift (result stale == snapshot stale).
		this.snapshot.stale = this.snapshot.currentResult?.stale ?? false;
		this.state.verification = this.snapshot;
		for (const listener of [...this.listeners]) {
			listener(this.snapshot);
		}
	}
}

/** Create the session's verification manager and return the handle. */
export function createAiraVerificationManager(
	state: AiraSessionState,
	agentEvents: (listener: (event: AgentEvent) => void) => () => void,
	options: AiraVerificationManagerOptions,
): AiraVerificationHandle {
	const manager = new AiraVerificationManager(state, agentEvents, options);
	manager.activate();
	return manager;
}

function computeRevisionId(files: readonly AiraChangeFile[], cwd: string): string {
	const hash = createHash("sha1");
	for (const file of files.slice(0, MAX_CHANGE_SET_FILES).sort((a, b) => (a.path < b.path ? -1 : 1))) {
		const mtime = fileMtimeMs(join(cwd, file.path));
		hash.update(
			`${file.status}\u0000${file.path}\u0000${mtime ?? "missing"}\u0000${file.added}\u0000${file.deleted}\u0001`,
		);
	}
	return hash.digest("base64url").slice(0, 16);
}

function changeSetChanged(current: readonly AiraChangeFile[], previous: readonly AiraChangeFile[]): boolean {
	if (current.length !== previous.length) {
		return true;
	}
	const previousPaths = new Set(previous.map((file) => file.path));
	for (const file of current) {
		if (!previousPaths.has(file.path)) {
			return true;
		}
	}
	return false;
}

function diagnosticsClean(intelligence: AiraSessionState["intelligence"]): boolean | undefined {
	if (!intelligence || !intelligence.active) {
		return undefined;
	}
	const findings = intelligence.findings;
	if (!findings || findings.stale > 0) {
		return undefined;
	}
	if (findings.errors > 0 || findings.warnings > 0) {
		return false;
	}
	return intelligence.liveCode.status === "ready" ? true : undefined;
}

function fileMtimeMs(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

function toRelative(cwd: string, path: string): string | undefined {
	const absolute = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) ? path : join(cwd, path);
	const normalized = absolute.replace(/\\/g, "/");
	const cwdNormalized = `${cwd.replace(/\\/g, "/")}/`;
	if (!normalized.startsWith(cwdNormalized)) {
		return undefined;
	}
	const rel = normalized.slice(cwdNormalized.length);
	return rel.length > 0 ? rel : undefined;
}

function lastUserMessageText(messages: unknown[], max: number): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") {
			continue;
		}
		const record = message as { role?: unknown; content?: unknown };
		if (record.role !== "user") {
			continue;
		}
		const text = messageText(record.content);
		if (text) {
			return boundedText(text, max);
		}
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

function toolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	const path = (args as Record<string, unknown>).path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function verdictState(verdict: AiraVerificationVerdict): AiraVerificationStatusState {
	return verdict === "pass" ? "passed" : verdict === "fail" ? "failed" : "inconclusive";
}

function highestFinding(
	findings: AiraVerificationResult["findings"],
): AiraVerificationResult["findings"][number] | undefined {
	if (findings.length === 0) {
		return undefined;
	}
	const order = { blocking: 0, warning: 1, info: 2 } as const;
	return [...findings].sort((a, b) => order[a.severity] - order[b.severity])[0];
}

function verifierResultId(counter: number): string {
	return `v-${counter.toString(36)}-${randomUUID().slice(0, 8)}`;
}
