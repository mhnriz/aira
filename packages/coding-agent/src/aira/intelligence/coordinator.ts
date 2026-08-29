/**
 * Aira intelligence — coordinator.
 *
 * The service owner. Decides activation from the canonical project profile,
 * arms the native providers (repository + live-code), subscribes to host
 * agent events (turns, tool executions), schedules automatic post-edit
 * diagnostics, builds the bounded ambient context message at prompt time,
 * and publishes health into canonical session state.
 *
 * Degradation contract: every subsystem is optional. A missing language
 * server, a failed scan, an unreadable cache, or a crashed provider never
 * throws into the host — the coordinator falls back to the previous
 * behavior (no intelligence) and records the failure in
 * `state.intelligence`.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AiraSessionState } from "../state.ts";
import { decideIntelligenceActivation, type IntelligenceActivation, isConservativeActivation } from "./activation.ts";
import { buildIntelligenceContext } from "./context.ts";
import { AiraFindingsStore } from "./findings.ts";
import { LiveCodeProvider } from "./providers/live-code/index.ts";
import { RepositoryProvider } from "./providers/repository/index.ts";
import type { GitChangeFileStats } from "./providers/repository/relationships.ts";
import type { AiraIntelligenceStatus } from "./status.ts";
import { initialAiraIntelligenceStatus } from "./status.ts";

export const AIRA_INTELLIGENCE_CONTEXT_TYPE = "aira.intelligence";

export interface AiraIntelligenceOptions {
	/** Cache directory for the repository index (Aira home cache). */
	cacheDir?: string;
	/** Repository scan cap (tests can shrink it). */
	repositoryMaxFiles?: number;
	/** Post-edit diagnostic debounce. */
	postEditDebounceMs?: number;
	/** Live-code provider options (tests inject the mock server). */
	liveCodeOptions?: ConstructorParameters<typeof LiveCodeProvider>[2];
}

/** The host-facing handle (owned by AgentSession). */
export interface AiraIntelligenceHandle {
	activate(): Promise<void>;
	/** Returns the ambient context message content, or undefined. */
	providePromptContext(prompt: string): string | undefined;
	/** Feed a host agent event into the coordinator (host subscription seam). */
	applyAgentEvent(event: AgentEvent): void;
	/** Wait for the repository provider's initial scan to settle (tests). */
	waitUntilSettled(): Promise<void>;
	/**
	 * Bounded per-file change stats for the Phase 8 verifier; undefined when
	 * git/repository evidence is unavailable (degrades truthfully).
	 */
	verificationChanges(): Promise<GitChangeFileStats[] | undefined>;
	dispose(): Promise<void>;
}

const DEFAULT_POST_EDIT_DEBOUNCE_MS = 400;

export class IntelligenceCoordinator implements AiraIntelligenceHandle {
	private activation: IntelligenceActivation = {
		active: false,
		reason: "not activated",
		languages: [],
		liveCodeCandidates: [],
		confidence: "none",
	};
	private repository: RepositoryProvider | undefined;
	private liveCode: LiveCodeProvider | undefined;
	private readonly findings = new AiraFindingsStore();
	private oriented = false;
	private lastInjectedHash: string | undefined;
	private readonly postEditTimers = new Map<string, NodeJS.Timeout>();
	private readonly pendingEdits = new Map<string, string>();
	private status: AiraIntelligenceStatus = initialAiraIntelligenceStatus();
	private degraded = false;
	private disposed = false;
	private turn = 0;
	private readonly state: AiraSessionState;
	private readonly agent: Agent | undefined;
	private readonly options: Required<Pick<AiraIntelligenceOptions, "postEditDebounceMs">> & AiraIntelligenceOptions;

	constructor(state: AiraSessionState, agent: Agent | undefined, options: AiraIntelligenceOptions = {}) {
		this.state = state;
		this.agent = agent;
		this.options = { postEditDebounceMs: DEFAULT_POST_EDIT_DEBOUNCE_MS, ...options };
	}

	/** Arm the service: decide activation, bind providers, subscribe to events. */
	async activate(): Promise<void> {
		if (this.disposed) {
			return;
		}
		try {
			this.activation = decideIntelligenceActivation(this.state.project);
			// Publish the decision synchronously (before any await) so the host
			// can observe an armed/disabled service immediately.
			this.publishStatus();
			if (!this.activation.active) {
				return;
			}
			const root = this.state.project?.root;
			if (!root) {
				this.publishStatus();
				return;
			}
			this.repository = new RepositoryProvider(root, {
				cacheDir: this.options.cacheDir,
				maxFiles: this.options.repositoryMaxFiles,
			});
			await this.repository.activate();
			// Await the initial scan so the published snapshot is accurate (the
			// scan itself stays cheap and bounded; activate runs in background).
			await this.repository.settled();
			await this.repository.refreshChanges();
			if (!isConservativeActivation(this.activation)) {
				this.liveCode = new LiveCodeProvider(root, this.findings, this.options.liveCodeOptions);
			}
			this.agent?.subscribe((event) => this.applyAgentEvent(event));
		} catch {
			this.degraded = true;
		}
		this.publishStatus();
	}

	/** Build the ambient context message for a prompt (synchronous, bounded). */
	providePromptContext(prompt: string): string | undefined {
		if (!this.activation.active || this.state.runtime !== "active") {
			return undefined;
		}
		const built = buildIntelligenceContext({
			prompt,
			mode: this.state.mode,
			activation: this.activation,
			projectRootName: basenameSafe(this.state.project?.root),
			repository: this.repository,
			findings: this.findings,
			oriented: this.oriented,
		});
		if (!built.content) {
			return undefined;
		}
		const hash = contentHash(built.content);
		if (hash === this.lastInjectedHash && !built.hasSignal) {
			// Identical context was already delivered and nothing moved: stay quiet.
			return undefined;
		}
		this.lastInjectedHash = hash;
		this.oriented = true;
		return built.content;
	}

	/** Shut down providers and timers (session end). */
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const timer of this.postEditTimers.values()) {
			clearTimeout(timer);
		}
		this.postEditTimers.clear();
		try {
			await this.liveCode?.dispose();
		} catch {
			// Best-effort teardown.
		}
	}

	/** Feed a host agent event into the coordinator (host subscription seam). */
	applyAgentEvent(event: AgentEvent): void {
		this.onAgentEvent(event);
	}

	/** Wait for the repository provider's initial scan to settle (tests). */
	async waitUntilSettled(): Promise<void> {
		await this.repository?.settled();
		this.publishStatus();
	}

	/** Bounded git change stats for the Phase 8 verifier (read-only). */
	async verificationChanges() {
		return this.repository?.verificationChanges();
	}

	private onAgentEvent = (event: AgentEvent): void => {
		if (this.disposed || !this.activation.active) {
			return;
		}
		if (event.type === "turn_start") {
			this.turn += 1;
			this.findings.setTurn(this.turn);
			return;
		}
		if (event.type === "tool_execution_start" && (event.toolName === "edit" || event.toolName === "write")) {
			// Remember the target path; `tool_execution_end` carries no args.
			const path = toolPath(event.args);
			if (path) {
				this.pendingEdits.set(event.toolCallId, path);
			}
			return;
		}
		if (event.type === "tool_execution_end" && (event.toolName === "edit" || event.toolName === "write")) {
			this.onToolExecuted(event.toolCallId, event.isError);
		}
	};

	private onToolExecuted(toolCallId: string, isError: boolean): void {
		const path = this.pendingEdits.get(toolCallId);
		this.pendingEdits.delete(toolCallId);
		if (!path || isError) {
			return;
		}
		// Previous evidence for this path is stale the moment the file moved.
		this.findings.clearPath(path);
		this.repository?.noteEdit(path);
		this.schedulePostEdit(path);
	}

	private schedulePostEdit(path: string): void {
		const existing = this.postEditTimers.get(path);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.postEditTimers.delete(path);
			void this.runPostEdit(path);
		}, this.options.postEditDebounceMs);
		this.postEditTimers.set(path, timer);
	}

	private async runPostEdit(path: string): Promise<void> {
		try {
			// Repository evidence first (fast, in-memory), then LSP diagnostics.
			await this.repository?.reindexFile(path);
			if (this.state.mode === "plan") {
				// Defense: POST-edit pipelines never run in PLAN (host already
				// blocks mutating tools; this is a second gate).
				return;
			}
			if (this.liveCode) {
				await this.liveCode.requestDiagnosticsForFile(path);
			}
		} catch {
			this.degraded = true;
		} finally {
			this.publishStatus();
		}
	}

	/** Publish the health snapshot into canonical session state. */
	private publishStatus(): void {
		const repo = this.repository?.statusInfo();
		const live = this.liveCode?.statusInfo();
		const counts = this.findings.counts();
		const stale = this.findings.refreshAll((path) => fileMtimeMs(path)).stale;
		this.status = {
			active: this.activation.active,
			activationReason: this.activation.reason,
			confidence: this.activation.confidence,
			languages: this.activation.languages,
			liveCode: {
				status: live?.status ?? "unavailable",
				servers: (live?.servers ?? []).map((s) => ({
					id: s.id,
					status: s.status,
					available: s.available,
					error: s.error,
				})),
				spawnCount: live?.spawnCount ?? 0,
				crashCount: live?.crashCount ?? 0,
			},
			repository: {
				status: repo?.status ?? "uninitialized",
				filesIndexed: repo?.filesIndexed ?? 0,
				cacheLoaded: repo?.cacheLoaded ?? false,
				error: repo?.error,
				changesAvailable: repo?.changes.available ?? false,
				changeCount: repo?.changes.count,
			},
			findings: {
				total: counts.paths === 0 ? 0 : this.findings.size,
				errors: counts.errors,
				warnings: counts.warnings,
				stale,
			},
			degraded: this.degraded,
		};
		this.state.intelligence = this.status;
	}
}

/** Create the session's intelligence coordinator and return the handle. */
export function createAiraIntelligence(
	state: AiraSessionState,
	agent: Agent | undefined,
	options: AiraIntelligenceOptions = {},
): AiraIntelligenceHandle {
	return new IntelligenceCoordinator(state, agent, options);
}

function contentHash(content: string): string {
	return createHash("sha1").update(content).digest("base64url").slice(0, 16);
}

function basenameSafe(path: string | undefined): string | undefined {
	if (!path) {
		return undefined;
	}
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.at(-1);
}

function fileMtimeMs(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

function toolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	const record = args as Record<string, unknown>;
	const path = record.path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}
