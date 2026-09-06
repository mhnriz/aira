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
import { realpath } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AiraSessionState } from "../state.ts";
import { decideIntelligenceActivation, type IntelligenceActivation, isConservativeActivation } from "./activation.ts";
import { buildIntelligenceContext } from "./context.ts";
import { type AiraFindingSeverity, AiraFindingsStore, type AiraFreshnessVerdict } from "./findings.ts";
import type { LiveCodeSemanticOperation, LiveCodeSemanticResult } from "./providers/live-code/index.ts";
import { LiveCodeProvider } from "./providers/live-code/index.ts";
import { RepositoryProvider } from "./providers/repository/index.ts";
import type { GitChangeFileStats } from "./providers/repository/relationships.ts";
import type { AiraIntelligenceStatus, AiraIntelligenceTopFinding } from "./status.ts";
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
	/**
	 * Bounded working-set stats (path, status, +/- lines) for UI projections
	 * (Phase 12 Workbench). Same canonical git seam as `verificationChanges`;
	 * UI callers coalesce through the Workbench controller so git processes
	 * never run at render frequency. Undefined when git is unavailable.
	 */
	workingSet(): Promise<GitChangeFileStats[] | undefined>;
	/**
	 * Bounded symbols from the working set (changed/edited paths) for the
	 * Phase 12 Workbench "Relevant Symbols" panel. Derived from the cached
	 * repository index — token-free and free of extra git/scan processes.
	 */
	relevantSymbols(limit?: number): Array<{ path: string; name: string; kind: string; line: number }>;
	searchSymbols(query: string, limit?: number): AiraSymbolSearchResult;
	moduleReport(path: string, limit?: number): Promise<AiraModuleReportResult>;
	semanticNavigation(query: AiraSemanticNavigationQuery): Promise<AiraSemanticNavigationResult>;
	/** Subscribe to intelligence snapshot changes (Phase 12 UI seam). */
	subscribe(listener: (status: AiraIntelligenceStatus) => void): () => void;
	dispose(): Promise<void>;
}

export interface AiraSymbolSearchResult {
	status: "ready" | "unavailable";
	query: string;
	results: Array<{ path: string; symbols: string[]; score: number }>;
	truncated: boolean;
	suggestedNext?: { tool: "aira_module_report"; path: string };
}

export interface AiraModuleReportResult {
	status: "ready" | "not-found" | "invalid-path" | "unavailable";
	path: string;
	language?: string;
	symbols: Array<{ name: string; kind: string; line: number }>;
	imports: string[];
	importedBy: string[];
	counterparts: string[];
	truncated: boolean;
	suggestedNext?: {
		tool: "aira_semantic_navigation" | "read";
		operation?: LiveCodeSemanticOperation;
		path?: string;
		symbol?: string;
	};
	reason?: string;
}

export interface AiraSemanticNavigationQuery {
	operation: LiveCodeSemanticOperation;
	path?: string;
	symbol?: string;
	line?: number;
	character?: number;
	limit?: number;
	signal?: AbortSignal;
}

export type AiraSemanticNavigationResult =
	| (LiveCodeSemanticResult & { path: string; suggestedNext?: { tool: "read"; path: string; line?: number } })
	| {
			status: "ambiguous" | "not-found" | "invalid-path" | "unavailable";
			operation: LiveCodeSemanticOperation;
			path?: string;
			symbol?: string;
			candidates?: Array<{ path: string; symbols: string[]; score: number }>;
			reason?: string;
			truncated: boolean;
	  };

const DEFAULT_POST_EDIT_DEBOUNCE_MS = 400;

function clampLimit(value: number, maximum: number): number {
	return Math.max(1, Math.min(Math.floor(value), maximum));
}

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
	private readonly listeners = new Set<(status: AiraIntelligenceStatus) => void>();
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

	/** Bounded working-set stats for UI projections (Phase 12; read-only). */
	async workingSet(): Promise<GitChangeFileStats[] | undefined> {
		return this.repository?.workingSet();
	}

	/** Subscribe to snapshot changes (Phase 12 UI seam; token-free). */
	subscribe(listener: (status: AiraIntelligenceStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Bounded symbols from the working set (changed/edited paths) for the
	 * Phase 12 Workbench "Relevant Symbols" panel. Derived from the cached
	 * repository index — token-free and free of extra git/scan processes.
	 */
	relevantSymbols(limit = 12): Array<{ path: string; name: string; kind: string; line: number }> {
		return this.repository?.relevantSymbols(limit) ?? [];
	}

	searchSymbols(query: string, limit = 12): AiraSymbolSearchResult {
		const boundedLimit = clampLimit(limit, 20);
		if (!this.repository) return { status: "unavailable", query, results: [], truncated: false };
		const hits = this.repository.discover(query, { limit: boundedLimit + 1 });
		const truncated = hits.length > boundedLimit;
		const results = hits.slice(0, boundedLimit).map((hit) => ({
			path: hit.path,
			symbols: hit.symbols,
			score: hit.score,
		}));
		return {
			status: "ready",
			query,
			results,
			truncated,
			...(results[0] ? { suggestedNext: { tool: "aira_module_report" as const, path: results[0].path } } : {}),
		};
	}

	async moduleReport(path: string, limit = 20): Promise<AiraModuleReportResult> {
		const boundedLimit = clampLimit(limit, 50);
		const resolved = await this.resolveProjectPath(path);
		if (!resolved.ok) {
			return {
				status: resolved.status,
				path,
				symbols: [],
				imports: [],
				importedBy: [],
				counterparts: [],
				truncated: false,
				reason: resolved.reason,
			};
		}
		const file = this.repository?.fileFor(resolved.path);
		if (!file) {
			return {
				status: this.repository ? "not-found" : "unavailable",
				path: this.relativePath(resolved.path),
				symbols: [],
				imports: [],
				importedBy: [],
				counterparts: [],
				truncated: false,
			};
		}
		const symbols = file.symbols.slice(0, boundedLimit).map((symbol) => ({ ...symbol }));
		const imports = this.repository?.imports(resolved.path) ?? [];
		const importedBy = this.repository?.importedBy(resolved.path) ?? [];
		const counterparts = this.repository?.counterparts(resolved.path) ?? [];
		const truncated =
			file.truncated ||
			file.symbols.length > boundedLimit ||
			imports.length > boundedLimit ||
			importedBy.length > boundedLimit ||
			counterparts.length > boundedLimit;
		const relativePath = this.relativePath(resolved.path);
		const firstSymbol = symbols[0];
		return {
			status: "ready",
			path: relativePath,
			language: file.language,
			symbols,
			imports: imports.slice(0, boundedLimit).map((item) => this.relativePath(item)),
			importedBy: importedBy.slice(0, boundedLimit).map((item) => this.relativePath(item)),
			counterparts: counterparts.slice(0, boundedLimit).map((item) => this.relativePath(item)),
			truncated,
			...(firstSymbol
				? {
						suggestedNext: {
							tool: "aira_semantic_navigation" as const,
							operation: "definition" as const,
							path: relativePath,
							symbol: firstSymbol.name,
						},
					}
				: { suggestedNext: { tool: "read" as const, path: relativePath } }),
		};
	}

	async semanticNavigation(query: AiraSemanticNavigationQuery): Promise<AiraSemanticNavigationResult> {
		if (query.operation === "symbols" && !query.path) {
			return {
				status: "invalid-path",
				operation: query.operation,
				truncated: false,
				reason: "symbols requires a path",
			};
		}
		if (!query.path && !query.symbol) {
			return {
				status: "not-found",
				operation: query.operation,
				truncated: false,
				reason: "definition and references require a symbol or path",
			};
		}
		let path = query.path;
		if (!path && query.symbol) {
			const search = this.searchSymbols(query.symbol, 20);
			if (search.status === "unavailable") {
				return { status: "unavailable", operation: query.operation, symbol: query.symbol, truncated: false };
			}
			const candidates = search.results.filter((candidate) => candidate.symbols.includes(query.symbol as string));
			if (candidates.length === 0) {
				return { status: "not-found", operation: query.operation, symbol: query.symbol, truncated: false };
			}
			if (candidates.length > 1) {
				return {
					status: "ambiguous",
					operation: query.operation,
					symbol: query.symbol,
					candidates: candidates.slice(0, 10),
					truncated: candidates.length > 10,
				};
			}
			path = candidates[0].path;
		}
		const resolved = await this.resolveProjectPath(path as string);
		if (!resolved.ok)
			return {
				status: resolved.status,
				operation: query.operation,
				path,
				truncated: false,
				reason: resolved.reason,
			};
		if (!this.liveCode)
			return {
				status: "unavailable",
				operation: query.operation,
				path: this.relativePath(resolved.path),
				truncated: false,
			};
		const result = await this.liveCode.semanticQuery({
			operation: query.operation,
			path: resolved.path,
			...(query.symbol !== undefined ? { symbol: query.symbol } : {}),
			...(query.line !== undefined ? { line: query.line } : {}),
			...(query.character !== undefined ? { character: query.character } : {}),
			...(query.limit !== undefined ? { maxResults: clampLimit(query.limit, 50) } : {}),
			signal: query.signal,
		});
		this.publishStatus();
		const outputPath = this.relativePath(resolved.path);
		return {
			...result,
			path: outputPath,
			...(result.status === "ready" && result.locations[0]
				? {
						suggestedNext: {
							tool: "read" as const,
							path: result.locations[0].path ?? outputPath,
							line: result.locations[0].line,
						},
					}
				: {}),
		};
	}

	private async resolveProjectPath(
		input: string,
	): Promise<{ ok: true; path: string } | { ok: false; status: "invalid-path" | "unavailable"; reason: string }> {
		if (!this.repository)
			return { ok: false, status: "unavailable", reason: "repository intelligence is unavailable" };
		if (input.includes("\0")) return { ok: false, status: "invalid-path", reason: "path contains a NUL character" };
		const root = this.repository.projectRoot;
		const candidate = resolvePath(root, input);
		const rootReal = await realpath(root).catch(() => root);
		const targetReal = await realpath(candidate).catch(() => undefined);
		if (!targetReal) return { ok: false, status: "invalid-path", reason: "path does not exist" };
		const rel = relative(rootReal, targetReal).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..") || rel.includes("\0")) {
			return { ok: false, status: "invalid-path", reason: "path is outside the project root" };
		}
		// Keep the provider's original root spelling for indexed lookups (macOS
		// commonly aliases /var to /private/var); targetReal was used only for
		// containment validation.
		return { ok: true, path: candidate };
	}

	private relativePath(path: string): string {
		return relative(this.repository?.projectRoot ?? path, path).replace(/\\/g, "/");
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
		const top = topAiraFindings(this.findings.all());
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
				top,
			},
			degraded: this.degraded,
		};
		this.state.intelligence = this.status;
		for (const listener of this.listeners) {
			listener(this.status);
		}
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

const AIRA_TOP_FINDINGS_LIMIT = 3;

/**
 * Bounded UI-ready top findings (errors first, then warnings, fresh first).
 * Purely a projection of the canonical findings store — no new truth.
 */
export function topAiraFindings(findings: AiraIntelligenceTopFindingSource[]): AiraIntelligenceTopFinding[] {
	const ranked = [...findings].sort((a, b) => {
		const severityRank = (severity: string): number => (severity === "error" ? 0 : severity === "warning" ? 1 : 2);
		const bySeverity = severityRank(a.severity) - severityRank(b.severity);
		if (bySeverity !== 0) return bySeverity;
		const freshnessRank = (freshness: string): number => (freshness === "fresh" ? 0 : freshness === "stale" ? 2 : 1);
		const byFreshness = freshnessRank(a.freshness) - freshnessRank(b.freshness);
		if (byFreshness !== 0) return byFreshness;
		return a.at - b.at;
	});
	return ranked.slice(0, AIRA_TOP_FINDINGS_LIMIT).map((f) => ({
		severity: f.severity,
		...(f.code !== undefined && f.code !== null ? { code: f.code } : {}),
		message: f.message,
		path: f.path,
		...(f.range ? { line: f.range.start.line + 1 } : {}),
		freshness: f.freshness,
	}));
}

type AiraIntelligenceTopFindingSource = {
	severity: AiraFindingSeverity;
	code?: string | number;
	message: string;
	path: string;
	at: number;
	freshness: AiraFreshnessVerdict;
	range?: { start: { line: number } };
};

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
