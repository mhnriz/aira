/**
 * Aira intelligence — live-code provider (LSP manager).
 *
 * Session-scoped, project-scoped language-server lifecycle:
 *
 * - lazy spawn (first use), reuse across operations, no per-op spawning;
 * - bounded open-document set (LRU eviction with didClose);
 * - idle eviction with a cooldown per server, so a crash-looping server
 *   cannot be respawned eagerly;
 * - crash tolerance: a crashed server degrades its language and never
 *   throws into the coordinator;
 * - diagnostics ingestion into the shared findings store, with LSP
 *   severity mapping and per-file collection timestamps.
 *
 * The manager never spawns a server purely for navigation: `navigate*`
 * operations return `undefined` when the server is not already running
 * (warm), so prompt-time usage stays cheap. `requestDiagnostics*` may
 * spawn/refresh because post-edit feedback is worth a bounded, debounced
 * warm-up.
 */
import { readFile } from "node:fs/promises";
import { extname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { AiraFinding, AiraFindingSeverity, AiraFindingsStore } from "../../findings.ts";
import {
	convertCharacterOffset,
	LSP_SEVERITY_ERROR,
	LSP_SEVERITY_WARNING,
	LspClient,
	type LspClientStatus,
	type LspDiagnostic,
} from "./lsp-client.ts";
import {
	type LaunchSpec,
	LIVE_CODE_SERVER_DEFINITIONS,
	type LspServerDefinition,
	resolveLaunchSpec,
	serverForLanguage,
} from "./registry.ts";

export type LiveCodeProviderStatus =
	| "unavailable" // no relevant language server resolvable (project or PATH)
	| "idle" // supported project; server resolvable but nothing spawned yet
	| "ready" // at least one server running
	| "degraded"; // servers exist but all are crashed/unavailable

export interface LiveCodeServerStatus {
	id: string;
	language: string;
	status: LspClientStatus | "unprobed";
	available: boolean;
	error?: string;
}

export interface LiveCodeProviderStatusInfo {
	status: LiveCodeProviderStatus;
	servers: LiveCodeServerStatus[];
	spawnCount: number;
	crashCount: number;
	evictionCount: number;
}

export type LiveCodeSemanticOperation = "definition" | "references" | "symbols";

export interface LiveCodeSemanticQuery {
	path: string;
	operation: LiveCodeSemanticOperation;
	/** LSP coordinates are zero-based. Either coordinates or symbol may identify the target. */
	line?: number;
	character?: number;
	symbol?: string;
	maxResults?: number;
	signal?: AbortSignal;
}

export interface LiveCodeSemanticLocation {
	uri: string;
	path?: string;
	line: number;
	character: number;
}

export type LiveCodeSemanticResult =
	| {
			status: "ready";
			operation: LiveCodeSemanticOperation;
			path: string;
			locations: LiveCodeSemanticLocation[];
			symbol?: string;
			truncated: boolean;
	  }
	| {
			status:
				| "no-results"
				| "symbol-not-found"
				| "unsupported-language"
				| "server-unavailable"
				| "timeout"
				| "cancelled"
				| "degraded";
			operation: LiveCodeSemanticOperation;
			path: string;
			symbol?: string;
			locations?: LiveCodeSemanticLocation[];
			reason?: string;
			truncated: false;
	  };

type LiveCodeSemanticFailureStatus = Exclude<LiveCodeSemanticResult["status"], "ready">;

/** One structured LSP diagnostic, projected from the shared findings store. */
export interface LiveCodeDiagnosticEntry {
	/** 1-based line where the diagnostic starts. */
	line?: number;
	/** 1-based character where the diagnostic starts. */
	character?: number;
	severity: AiraFindingSeverity;
	/** The server's diagnostic code when provided (e.g. "TS2322" / 2322). */
	code?: string | number;
	/** Origin: the server's own source field, else the language-server id. */
	source: string;
	message: string;
}

/**
 * Per-file outcomes are truthful: `ready` with an empty list means the server
 * published and the file is clean; `no-publish` means the server produced
 * nothing inside the bounded budget; `server-unavailable` means it could not
 * be started. Never fabricated.
 */
export type LiveCodeDiagnosticsFileStatus =
	| "ready"
	| "no-publish"
	| "unsupported-language"
	| "server-unavailable"
	| "unreadable"
	| "cancelled"
	| "degraded";

export interface LiveCodeDiagnosticsFileResult {
	/** Absolute path (coordinator relativizes for the model surface). */
	path: string;
	status: LiveCodeDiagnosticsFileStatus;
	diagnostics: LiveCodeDiagnosticEntry[];
	truncated: boolean;
	reason?: string;
}

export interface LiveCodeDiagnosticsQueryResult {
	status: "ready" | "cancelled" | "degraded";
	files: LiveCodeDiagnosticsFileResult[];
	totals: { errors: number; warnings: number; other: number };
	truncated: boolean;
	reason?: string;
}

export interface LiveCodeDiagnosticsQueryOptions {
	/** Publish wait budget per file (default: the provider's diagnosticWaitMs). */
	waitMs?: number;
	/** Hard cap on files diagnosed per query (default 10, max 20). */
	maxFiles?: number;
	/** Diagnostic entries cap per file (default 50, max 100). */
	maxDiagnosticsPerFile?: number;
	signal?: AbortSignal;
}

export interface LiveCodeProviderOptions {
	/** How many documents to keep open per server (LRU; extras close first). */
	maxOpenDocuments?: number;
	/** Idle timeout before an unused server is shut down. */
	idleTimeoutMs?: number;
	/** Crash cooldown before a crashed server may be respawned. */
	crashCooldownMs?: number;
	/** Diagnostic wait budget after a sync (post-edit). */
	diagnosticWaitMs?: number;
	/** Launch override per server id (tests, managed runtimes). */
	launchOverrides?: Readonly<Record<string, LaunchSpec>>;
	/** LSP request timeout (tests shrink it; default 10s). */
	requestTimeoutMs?: number;
}

const DEFAULT_MAX_OPEN_DOCUMENTS = 12;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
/**
 * Grace added to idle checks so a firing check can never observe a delta
 * just below the timeout (1ms-adjacent touches/status events used to make
 * eviction perpetually miss at small timeouts — repair-round finding).
 */
const IDLE_CHECK_SLACK_MS = 2;
const DEFAULT_CRASH_COOLDOWN_MS = 30_000;
const DEFAULT_DIAGNOSTIC_WAIT_MS = 1200;
const DEFAULT_SEMANTIC_RESULT_LIMIT = 50;
const MAX_SEMANTIC_RESULT_LIMIT = 100;
const DEFAULT_DIAGNOSTICS_MAX_FILES = 10;
const MAX_DIAGNOSTICS_MAX_FILES = 20;
const DEFAULT_DIAGNOSTICS_MAX_PER_FILE = 50;
const MAX_DIAGNOSTICS_MAX_PER_FILE = 100;

export class LiveCodeProvider {
	private readonly clients = new Map<string, LspClient>();
	private readonly statuses = new Map<string, LiveCodeServerStatus>();
	private readonly openDocuments = new Map<string, string>(); // path -> language
	private readonly openOrder: string[] = [];
	private readonly pendingDiagnostics = new Map<string, { timer: NodeJS.Timeout; waiters: Set<() => void> }>();
	/** When each path last received a publishDiagnostics (truthful ready/no-publish split). */
	private readonly diagnosticsPublishedAt = new Map<string, number>();
	private readonly idleTimers = new Map<string, NodeJS.Timeout>();
	private lastActivityAt = new Map<string, number>();
	private crashedAt = new Map<string, number>();
	private spawnCount = 0;
	private crashCount = 0;
	private evictionCount = 0;
	private disposed = false;
	private generation = 0;

	private readonly launchOverrides: Readonly<Record<string, LaunchSpec>>;
	private readonly requestTimeoutMs: number;
	private readonly projectRoot: string;
	private readonly findings: AiraFindingsStore;
	private readonly maxOpenDocuments: number;
	private readonly idleTimeoutMs: number;
	private readonly crashCooldownMs: number;
	private readonly diagnosticWaitMs: number;

	constructor(projectRoot: string, findings: AiraFindingsStore, options: LiveCodeProviderOptions = {}) {
		this.projectRoot = projectRoot;
		this.findings = findings;
		this.launchOverrides = options.launchOverrides ?? {};
		this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
		this.maxOpenDocuments = options.maxOpenDocuments ?? DEFAULT_MAX_OPEN_DOCUMENTS;
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.crashCooldownMs = options.crashCooldownMs ?? DEFAULT_CRASH_COOLDOWN_MS;
		this.diagnosticWaitMs = options.diagnosticWaitMs ?? DEFAULT_DIAGNOSTIC_WAIT_MS;
	}

	/** The LSP language id for a file (or undefined when unsupported). */
	languageForFile(path: string): string | undefined {
		const definition = this.definitionForFile(path);
		if (!definition) {
			return undefined;
		}
		const extension = extname(path).toLowerCase();
		const byExtension = {
			".ts": "typescript",
			".tsx": "typescriptreact",
			".mts": "typescript",
			".cts": "typescript",
			".js": "javascript",
			".jsx": "javascriptreact",
			".mjs": "javascript",
			".cjs": "javascript",
			".py": "python",
			".go": "go",
			".rs": "rust",
			".c": "c",
			".cpp": "cpp",
			".h": "c",
			".hpp": "cpp",
			".cs": "csharp",
		} satisfies Record<string, string>;
		return byExtension[extension as keyof typeof byExtension] ?? definition.languageIds[0];
	}

	private definitionForFile(path: string): LspServerDefinition | undefined {
		const extension = extname(path).toLowerCase();
		const byExtension = {
			".ts": "typescript",
			".tsx": "typescript",
			".mts": "typescript",
			".cts": "typescript",
			".js": "typescript",
			".jsx": "typescript",
			".mjs": "typescript",
			".cjs": "typescript",
			".py": "python",
			".go": "go",
			".rs": "rust",
			".c": "cpp",
			".cpp": "cpp",
			".h": "cpp",
			".hpp": "cpp",
			".cs": "csharp",
		} satisfies Record<string, string>;
		const repositoryLanguage = byExtension[extension as keyof typeof byExtension];
		return repositoryLanguage ? serverForLanguage(repositoryLanguage) : undefined;
	}

	/**
	 * Ensure a client exists for a file's server (spawning lazily when the
	 * server is installed). Returns the client or undefined (unsupported
	 * language / server not installed / crashed within cooldown).
	 */
	private async ensureClient(path: string, signal?: AbortSignal): Promise<LspClient | undefined> {
		signal?.throwIfAborted();
		if (this.disposed) {
			return undefined;
		}
		const definition = this.definitionForFile(path);
		if (!definition) {
			return undefined;
		}
		const language = this.languageForFile(path);
		if (!language) {
			return undefined;
		}
		const key = definition.id;
		const existing = this.clients.get(key);
		if (existing) {
			return existing.status === "running" || existing.status === "starting" ? existing : undefined;
		}

		const crashedAt = this.crashedAt.get(key);
		if (crashedAt && Date.now() - crashedAt < this.crashCooldownMs) {
			return undefined;
		}

		const spec = this.launchOverrides?.[definition.id] ?? resolveLaunchSpec(definition, this.projectRoot);
		if (!spec) {
			this.setServerStatus(key, language, "new", false, "server not installed");
			return undefined;
		}

		const client = new LspClient(
			spec,
			this.projectRoot,
			{
				onDiagnostics: ({ uri, diagnostics }) => this.ingestDiagnostics(uri, language, diagnostics),
				onLog: () => undefined,
				onStatusChange: (status, error) => {
					const available = status === "running" || status === "starting";
					this.setServerStatus(key, language, status, available, error);
					if (status === "crashed") {
						this.crashCount += 1;
						this.crashedAt.set(key, Date.now());
						this.clients.delete(key);
					}
					this.scheduleIdleCheck(key);
				},
			},
			this.requestTimeoutMs,
		);
		this.clients.set(key, client);
		this.spawnCount += 1;
		this.setServerStatus(key, language, "starting", true);
		try {
			await client.start(signal);
		} catch (error) {
			if (signal?.aborted) {
				client.killChild();
				this.clients.delete(key);
				throw error;
			}
			// The handshake failed (e.g. initialize timed out). The client is
			// abandoned, so the spawned child must be killed — an untracked
			// server would otherwise hold the session's stdio pipes and orphan
			// (host process never exits; a server process leaks per failed spawn).
			client.killChild();
			this.clients.delete(key);
			return undefined;
		}
		signal?.throwIfAborted();
		this.touch(key);
		return client;
	}

	/** True when the provider has a running client for a file's language. */
	isWarm(path: string): boolean {
		const definition = this.definitionForFile(path);
		if (!definition) {
			return false;
		}
		const client = this.clients.get(definition.id);
		return client?.status === "running";
	}

	/** Sync a file into the server (didOpen or didChange) and return its client. */
	private async syncFile(
		path: string,
		signal?: AbortSignal,
		/** Preloaded content; avoids a second read and avoids spawning for unreadable files. */
		preloadedText?: string,
	): Promise<{ client: LspClient | undefined; language: string | undefined }> {
		const client = await this.ensureClient(path, signal);
		const language = this.languageForFile(path);
		if (!client || !language) {
			return { client: undefined, language };
		}
		this.touch(client.serverId);
		const text = preloadedText ?? (await readFile(path, "utf8").catch(() => undefined));
		if (text === undefined) {
			return { client: undefined, language };
		}
		if (this.openDocuments.has(path)) {
			signal?.throwIfAborted();
			await client.didChange(path, text);
		} else {
			signal?.throwIfAborted();
			await client.didOpen(path, language, text);
			this.openDocuments.set(path, language);
			this.openOrder.push(path);
			this.evictDocuments(client);
		}
		return { client, language };
	}

	private evictDocuments(client: LspClient): void {
		while (this.openOrder.length > this.maxOpenDocuments) {
			const evicted = this.openOrder.shift();
			if (!evicted) {
				break;
			}
			this.openDocuments.delete(evicted);
			this.evictionCount += 1;
			void this.closeEvicted(client, evicted);
		}
	}

	private async closeEvicted(client: LspClient, path: string): Promise<void> {
		try {
			await client.didClose(path);
		} catch {
			// Eviction close is best-effort.
		}
	}

	/**
	 * Post-edit diagnostics: sync the file, wait a bounded budget for a
	 * publish, and return whatever findings arrived (cached publishes for the
	 * path are always ingested, so late publishes still land in the store).
	 */
	async requestDiagnosticsForFile(path: string, waitMs?: number): Promise<void> {
		const { client } = await this.syncFile(path);
		if (!client) {
			return;
		}
		await this.waitForDiagnostics(path, waitMs ?? this.diagnosticWaitMs);
	}

	/**
	 * Explicit semantic navigation. Unlike navigate(), this path is allowed to
	 * cold-start the matching server and returns a truthful bounded result rather
	 * than collapsing every failure into undefined.
	 */
	async semanticQuery(query: LiveCodeSemanticQuery): Promise<LiveCodeSemanticResult> {
		const { path, operation, symbol, signal } = query;
		const generation = this.generation;
		const maxResults = Math.min(
			MAX_SEMANTIC_RESULT_LIMIT,
			Math.max(1, Math.floor(query.maxResults ?? DEFAULT_SEMANTIC_RESULT_LIMIT)),
		);
		const unsupported = (status: LiveCodeSemanticFailureStatus, reason?: string): LiveCodeSemanticResult => ({
			status,
			operation,
			path,
			...(symbol ? { symbol } : {}),
			...(reason ? { reason } : {}),
			truncated: false,
		});

		if (this.disposed) return unsupported("cancelled", "provider disposed");
		if (!this.definitionForFile(path)) return unsupported("unsupported-language", "no registered server for file");
		if (operation !== "symbols" && query.line === undefined && !symbol) {
			return unsupported("symbol-not-found", "provide a symbol or zero-based line");
		}

		try {
			signal?.throwIfAborted();
			const synced = await this.syncFile(path, signal);
			if (generation !== this.generation || this.disposed) {
				return unsupported("cancelled", "provider disposed during query");
			}
			if (!synced.client) return unsupported("server-unavailable", "language server could not be started");
			const client = synced.client;
			if (operation === "symbols") {
				const symbols = await client.documentSymbols(path, signal);
				const locations = symbols.slice(0, maxResults).map((entry) => ({
					uri: pathToFileURL(path).href,
					path,
					line: entry.selectionRange.start.line + 1,
					character: entry.selectionRange.start.character + 1,
				}));
				if (generation !== this.generation || this.disposed)
					return unsupported("cancelled", "provider disposed during query");
				if (locations.length === 0) {
					return { status: "no-results", operation, path, locations: [], truncated: false };
				}
				return { status: "ready", operation, path, locations, truncated: symbols.length > maxResults };
			}

			const position = await this.semanticPosition(path, client, symbol, query.line, query.character, signal);
			if (!position) return unsupported("symbol-not-found", "symbol was not found in the synchronized document");
			const locations =
				operation === "definition"
					? await client.definitions(path, position.line, position.character, signal)
					: await client.references(path, position.line, position.character, false, signal);
			const bounded = locations.slice(0, maxResults).map((location) => ({
				uri: location.uri,
				...(location.uri.startsWith("file:") ? { path: this.displayPath(location.uri) } : {}),
				line: location.range.start.line + 1,
				character: location.range.start.character + 1,
			}));
			if (generation !== this.generation || this.disposed)
				return unsupported("cancelled", "provider disposed during query");
			return bounded.length > 0
				? {
						status: "ready",
						operation,
						path,
						...(symbol ? { symbol } : {}),
						locations: bounded,
						truncated: locations.length > maxResults,
					}
				: { status: "no-results", operation, path, ...(symbol ? { symbol } : {}), locations: [], truncated: false };
		} catch (error) {
			if (signal?.aborted || generation !== this.generation || this.disposed) {
				return unsupported(
					"cancelled",
					signal?.aborted ? "semantic query aborted" : "provider disposed during query",
				);
			}
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("timed out")) return unsupported("timeout", message);
			return unsupported("degraded", message);
		}
	}

	/**
	 * Explicit diagnostics query: sync each scoped file (cold-starting its
	 * language server on demand, reusing the warm client), wait a bounded
	 * budget for publishes, and project the store's findings back per file.
	 * Only the requested files are diagnosed — never the whole repository.
	 * Per-file statuses distinguish a clean publish (`ready`, empty list)
	 * from no publish within budget (`no-publish`) and from a server that
	 * could not start (`server-unavailable`).
	 */
	async requestDiagnostics(
		paths: readonly string[],
		options: LiveCodeDiagnosticsQueryOptions = {},
	): Promise<LiveCodeDiagnosticsQueryResult> {
		const waitMs = options.waitMs ?? this.diagnosticWaitMs;
		const maxFiles = Math.max(
			1,
			Math.min(MAX_DIAGNOSTICS_MAX_FILES, Math.floor(options.maxFiles ?? DEFAULT_DIAGNOSTICS_MAX_FILES)),
		);
		const maxPerFile = Math.max(
			1,
			Math.min(
				MAX_DIAGNOSTICS_MAX_PER_FILE,
				Math.floor(options.maxDiagnosticsPerFile ?? DEFAULT_DIAGNOSTICS_MAX_PER_FILE),
			),
		);
		const emptyTotals = { errors: 0, warnings: 0, other: 0 };
		const cancelled = (reason: string): LiveCodeDiagnosticsQueryResult => ({
			status: "cancelled",
			files: [],
			totals: emptyTotals,
			truncated: false,
			reason,
		});

		if (this.disposed) {
			return cancelled("provider disposed");
		}
		if (paths.length === 0) {
			return { status: "ready", files: [], totals: emptyTotals, truncated: false };
		}

		const generation = this.generation;
		const scope = paths.slice(0, maxFiles);
		const truncatedFiles = paths.length > scope.length;
		const startedAt = Date.now();
		const files: LiveCodeDiagnosticsFileResult[] = [];
		const syncedPaths: string[] = [];

		// Sequential syncs: a cold start must never race two spawns for one
		// server id (ensureClient has no in-flight dedup); later files reuse
		// the warm client. Publish waits below run in parallel.
		const signal = options.signal;
		for (const path of scope) {
			if (this.disposed || generation !== this.generation) {
				return cancelled("provider disposed during query");
			}
			try {
				signal?.throwIfAborted();
			} catch {
				return cancelled("diagnostics query aborted");
			}
			if (!this.definitionForFile(path)) {
				files.push({
					path,
					status: "unsupported-language",
					diagnostics: [],
					truncated: false,
					reason: "no registered language server for this file type",
				});
				continue;
			}
			const text = await readFile(path, "utf8").catch(() => undefined);
			if (text === undefined) {
				files.push({ path, status: "unreadable", diagnostics: [], truncated: false });
				continue;
			}
			const synced = await this.syncFile(path, signal, text);
			if (this.disposed || generation !== this.generation) {
				return cancelled("provider disposed during query");
			}
			if (!synced.client) {
				files.push({
					path,
					status: "server-unavailable",
					diagnostics: [],
					truncated: false,
					reason: this.unavailableReason(path),
				});
				continue;
			}
			syncedPaths.push(path);
		}

		// Bounded parallel publish wait (resolves early per path on publish).
		await Promise.all(syncedPaths.map((path) => this.waitForDiagnostics(path, waitMs)));
		if (this.disposed || generation !== this.generation) {
			return cancelled("provider disposed during query");
		}
		if (signal?.aborted) {
			return cancelled("diagnostics query aborted");
		}

		const totals = { errors: 0, warnings: 0, other: 0 };
		for (const path of syncedPaths) {
			const published = (this.diagnosticsPublishedAt.get(path) ?? 0) >= startedAt;
			const found = this.findings.forPath(path);
			const entries = found.slice(0, maxPerFile).map((finding) => diagnosticsEntry(finding));
			for (const entry of entries) {
				if (entry.severity === "error") totals.errors += 1;
				else if (entry.severity === "warning") totals.warnings += 1;
				else totals.other += 1;
			}
			files.push({
				path,
				status: published ? "ready" : "no-publish",
				diagnostics: entries,
				truncated: found.length > maxPerFile,
			});
		}
		return { status: "ready", files, totals, truncated: truncatedFiles };
	}

	/** Why a server could not be reached for a file (truthful reason strings). */
	private unavailableReason(path: string): string | undefined {
		const definition = this.definitionForFile(path);
		if (!definition) {
			return undefined;
		}
		const crashedAt = this.crashedAt.get(definition.id);
		if (crashedAt) {
			return "language server crashed recently; respawn is on cooldown";
		}
		const spec = this.launchOverrides?.[definition.id] ?? resolveLaunchSpec(definition, this.projectRoot);
		if (!spec) {
			return "language server is not installed";
		}
		return "language server could not be started";
	}

	/** Wait (bounded) for a publishDiagnostics for a path; resolves early when it lands. */
	private async waitForDiagnostics(path: string, budgetMs: number): Promise<void> {
		const existing = this.pendingDiagnostics.get(path);
		if (existing) {
			await new Promise<void>((resolve) => existing.waiters.add(resolve));
			return;
		}
		const waiters = new Set<() => void>();
		const finish = () => {
			const latch = this.pendingDiagnostics.get(path);
			if (latch) {
				clearTimeout(latch.timer);
				this.pendingDiagnostics.delete(path);
			}
			for (const waiter of waiters) {
				waiter();
			}
		};
		const timer = setTimeout(finish, budgetMs);
		this.pendingDiagnostics.set(path, { timer, waiters });
		await new Promise<void>((resolve) => {
			waiters.add(resolve);
		});
	}

	/**
	 * Navigation (warm-only): definitions/references/document symbols for a
	 * symbol at a line. Returns undefined when the LSP server is not already
	 * running (no cold spawn on this path).
	 */
	async navigate(
		path: string,
		operation: "definition" | "references" | "symbols",
		symbol?: string,
		line?: number,
	): Promise<
		| {
				locations: Array<{
					uri: string;
					range: { start: { line: number; character: number }; end: { line: number; character: number } };
				}>;
		  }
		| { symbols: Array<{ name: string; kind: number; line: number }> }
		| undefined
	> {
		const definition = this.definitionForFile(path);
		if (!definition) {
			return undefined;
		}
		const client = this.clients.get(definition.id);
		if (!client || client.status !== "running") {
			return undefined;
		}
		this.touch(client.serverId);
		try {
			if (operation === "symbols") {
				const symbols = await client.documentSymbols(path);
				return {
					symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.selectionRange.start.line })),
				};
			}
			const content = await readFile(path, "utf8").catch(() => "");
			const position = this.positionForSymbol(content, client, symbol, line);
			if (!position) {
				return undefined;
			}
			const locations =
				operation === "definition"
					? await client.definitions(path, position.line, position.character)
					: await client.references(path, position.line, position.character);
			return {
				locations: locations.map((l) => ({
					uri: l.uri,
					range: {
						start: { line: l.range.start.line, character: l.range.start.character },
						end: { line: l.range.end.line, character: l.range.end.character },
					},
				})),
			};
		} catch {
			return undefined;
		}
	}

	/** Resolve a symbol name or line to a concrete (line, character) position. */
	private positionForSymbol(
		content: string,
		client: LspClient,
		symbol: string | undefined,
		line: number | undefined,
	): { line: number; character: number } | undefined {
		if (line !== undefined && line >= 0) {
			const text = content.split("\n")[line] ?? "";
			const first = text.search(/[A-Za-z_$]/);
			return {
				line,
				character: convertCharacterOffset(client.isPositionUtf8 ? "utf-8" : "utf-16", text, Math.max(0, first)),
			};
		}
		if (!symbol) {
			return undefined;
		}
		const lines = content.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const text = lines[index] ?? "";
			const column = text.indexOf(symbol);
			if (column !== -1) {
				return {
					line: index,
					character: convertCharacterOffset(client.isPositionUtf8 ? "utf-8" : "utf-16", text, column),
				};
			}
		}
		return undefined;
	}

	private async semanticPosition(
		path: string,
		client: LspClient,
		symbol: string | undefined,
		line: number | undefined,
		character: number | undefined,
		signal?: AbortSignal,
	): Promise<{ line: number; character: number } | undefined> {
		if (line !== undefined) {
			if (line < 0 || (character !== undefined && character < 0)) return undefined;
			const content = await readFile(path, "utf8").catch(() => "");
			const text = content.split("\n")[line] ?? "";
			const column = character ?? (symbol ? text.indexOf(symbol) : text.search(/[A-Za-z_$]/));
			if (column < 0) return undefined;
			return { line, character: convertCharacterOffset(client.isPositionUtf8 ? "utf-8" : "utf-16", text, column) };
		}
		if (!symbol) return undefined;
		const documentSymbols = await client.documentSymbols(path, signal);
		const declared = documentSymbols.find((entry) => entry.name === symbol);
		if (declared) return declared.selectionRange.start;
		const content = await readFile(path, "utf8").catch(() => "");
		for (const [index, text] of content.split("\n").entries()) {
			const column = text.indexOf(symbol);
			if (column >= 0) {
				return {
					line: index,
					character: convertCharacterOffset(client.isPositionUtf8 ? "utf-8" : "utf-16", text, column),
				};
			}
		}
		return undefined;
	}

	private displayPath(uri: string): string {
		try {
			const absolute = new URL(uri).pathname;
			const displayed = relative(this.projectRoot, absolute).replace(/\\/g, "/");
			return displayed && !displayed.startsWith("..") ? displayed : absolute;
		} catch {
			return uri;
		}
	}

	private ingestDiagnostics(uri: string, language: string, diagnostics: LspDiagnostic[]): void {
		const path = uriToPath(uri);
		if (!path) {
			return;
		}
		this.diagnosticsPublishedAt.set(path, Date.now());
		const collectedAt = this.diagnosticsPublishedAt.get(path) ?? Date.now();
		this.findings.replaceForPath(
			path,
			diagnostics.map((diagnostic) => ({
				path,
				source: "lsp",
				providerId: language,
				severity: diagnosticSeverity(diagnostic),
				message: diagnostic.message,
				code: diagnostic.code,
				...(diagnostic.source !== undefined ? { lspSource: diagnostic.source } : {}),
				range: {
					start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
					end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
				},
				version: undefined,
			})),
			collectedAt,
		);
		const latch = this.pendingDiagnostics.get(path);
		if (latch) {
			for (const waiter of latch.waiters) {
				waiter();
			}
			clearTimeout(latch.timer);
			this.pendingDiagnostics.delete(path);
		}
	}

	private touch(serverKey: string): void {
		this.lastActivityAt.set(serverKey, Date.now());
		this.scheduleIdleCheck(serverKey);
	}

	private scheduleIdleCheck(serverKey: string): void {
		const existing = this.idleTimers.get(serverKey);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.idleTimers.delete(serverKey);
			const client = this.clients.get(serverKey);
			// Evict only a running client that was actually touched. Checks
			// scheduled during the starting handshake (or from a previous
			// server instance's stale activity) must neither kill a starting
			// server nor keep a stale timestamp cycling: with no touch the
			// handshake's own touch schedules the definitive check.
			if (!client || client.status !== "running") {
				return;
			}
			const last = this.lastActivityAt.get(serverKey) ?? 0;
			if (last > 0 && Date.now() - last >= this.idleTimeoutMs) {
				void this.shutdownServer(serverKey).catch(() => undefined);
			}
			// Slack beyond the timeout makes the delta at firing time at least
			// the timeout for ANY timer armed at/after the last touch; a check
			// armed 1ms before a touch can otherwise fire at delta=timeout-1,
			// miss, and be re-armed by lagging status events indefinitely
			// (a server that never idle-evicts — repair-round finding).
		}, this.idleTimeoutMs + IDLE_CHECK_SLACK_MS);
		timer.unref();
		this.idleTimers.set(serverKey, timer);
	}

	/** Shut down one server (used by idle eviction and dispose). */
	private async shutdownServer(serverKey: string): Promise<void> {
		const client = this.clients.get(serverKey);
		if (!client) {
			return;
		}
		this.clients.delete(serverKey);
		const status = this.statuses.get(serverKey);
		if (status) {
			status.status = "closed";
			status.available = false;
		}
		await client.shutdown();
	}

	/** Shut down every server (session end). */
	async dispose(): Promise<void> {
		this.generation += 1;
		this.disposed = true;
		for (const timer of this.idleTimers.values()) {
			clearTimeout(timer);
		}
		this.idleTimers.clear();
		for (const latch of this.pendingDiagnostics.values()) {
			clearTimeout(latch.timer);
			// Release in-flight waiters so pending diagnostic awaits settle
			// instead of hanging past teardown (disposal/cancellation contract).
			for (const waiter of latch.waiters) {
				waiter();
			}
		}
		this.pendingDiagnostics.clear();
		this.diagnosticsPublishedAt.clear();
		await Promise.all([...this.clients.keys()].map((key) => this.shutdownServer(key)));
	}

	private setServerStatus(
		id: string,
		language: string,
		status: LspClientStatus,
		available: boolean,
		error?: string,
	): void {
		this.statuses.set(id, { id, language, status, available, error });
	}

	/** Availability snapshot for a repository language. */
	availabilityForLanguage(language: string): { available: boolean; serverId?: string; status?: string } {
		const definition = serverForLanguage(language);
		if (!definition) {
			return { available: false };
		}
		const status = this.statuses.get(definition.id);
		if (!status) {
			// Never probed: only truly available when the command resolves.
			const spec = resolveLaunchSpec(definition, this.projectRoot);
			return { available: Boolean(spec), serverId: definition.id, status: "unprobed" };
		}
		return { available: status.available, serverId: definition.id, status: status.status };
	}

	/** Overall provider health snapshot. */
	statusInfo(): LiveCodeProviderStatusInfo {
		const servers = [...this.statuses.entries()].map(([id, status]) => ({ ...status, id }));
		const anyRunning = [...this.clients.values()].some((c) => c.status === "running" || c.status === "starting");
		const anyAvailable = servers.some((s) => s.available);
		let overall: LiveCodeProviderStatus = "unavailable";
		if (servers.length === 0 && this.spawnCount === 0) {
			// Cold/unprobed: nothing was ever spawned. Resolve availability
			// through the normal launch path (never spawns) so a supported
			// project with a resolvable server reports `idle`, not `unavailable`.
			servers.push(...this.probeUnprobedServers());
			if (servers.some((s) => s.available)) {
				overall = "idle";
			}
		} else if (servers.length > 0 && !anyAvailable && this.crashCount > 0) {
			overall = "degraded";
		} else if (anyRunning) {
			overall = "ready";
		} else if (servers.length > 0 || this.spawnCount > 0) {
			overall = "idle";
		}
		return {
			status: overall,
			servers,
			spawnCount: this.spawnCount,
			crashCount: this.crashCount,
			evictionCount: this.evictionCount,
		};
	}

	/** Resolve every registered server's launchability without spawning. */
	private probeUnprobedServers(): LiveCodeServerStatus[] {
		const probed: LiveCodeServerStatus[] = [];
		for (const definition of LIVE_CODE_SERVER_DEFINITIONS) {
			const spec = this.launchOverrides?.[definition.id] ?? resolveLaunchSpec(definition, this.projectRoot);
			probed.push({
				id: definition.id,
				language: definition.languageIds[0] ?? definition.id,
				status: "unprobed",
				available: spec !== undefined,
			});
		}
		return probed;
	}

	/** Registered server ids (health surface). */
	registeredIds(): string[] {
		return [...this.statuses.keys()];
	}
}

function uriToPath(uri: string): string | undefined {
	try {
		const url = new URL(uri);
		if (url.protocol !== "file:") {
			return undefined;
		}
		return pathToFileURL(url.pathname).pathname;
	} catch {
		return undefined;
	}
}

function diagnosticSeverity(diagnostic: LspDiagnostic): "error" | "warning" | "information" {
	if (diagnostic.severity === LSP_SEVERITY_ERROR) {
		return "error";
	}
	if (diagnostic.severity === LSP_SEVERITY_WARNING) {
		return "warning";
	}
	return "information";
}

/** Project one stored finding into the model-facing diagnostic entry shape. */
function diagnosticsEntry(finding: AiraFinding): LiveCodeDiagnosticEntry {
	const start = finding.range?.start;
	return {
		...(start !== undefined ? { line: start.line + 1, character: start.character + 1 } : {}),
		severity: finding.severity,
		...(finding.code !== undefined && finding.code !== null ? { code: finding.code } : {}),
		source: finding.lspSource ?? finding.providerId,
		message: finding.message,
	};
}
