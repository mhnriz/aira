import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { classifyAiraBrowserOperation, classifyAiraCapability } from "../aira/capabilities.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

/**
 * Session-local repository observation store (Aira 0.1.7, Step 7).
 *
 * Purpose: avoid a *physical* repository read when Aira already observed the
 * exact file region at the exact repository version it is about to read again
 * — without ever trading correctness for fewer reads.
 *
 * This is deliberately NOT a filesystem cache, indexer, content-addressable
 * store, or watcher:
 *  - session-local and in-memory (nothing persists across sessions);
 *  - never observes the filesystem in the background;
 *  - stores only line regions Aira already read for the model, bounded by the
 *    read tool's own truncation limits;
 *  - fails stale: any doubt about freshness turns into a miss.
 *
 * Freshness has two independent gates, both must pass:
 *  1. a cheap deterministic fingerprint (mtime + size + regular-file) taken
 *     from the filesystem right now must equal the fingerprint recorded when
 *     the region was read;
 *  2. no known mutation may have touched the path since. Aira's own `edit` /
 *     `write` increments a path-scoped mutation counter; anything that could
 *     mutate the workspace without a provable path (shell commands, child
 *     agents, browser interaction that can reach a local server, and unknown
 *     extension tools) raises an uncertainty counter that invalidates every
 *     observation.
 *
 * Gate 1 catches external drift (another process edited the file) and gate 2
 * catches same-millisecond/same-size mutations that a fingerprint alone could
 * miss. When either gate cannot be established cheaply, the store misses and
 * the caller performs the normal physical read.
 */

/**
 * Hard cap on retained observations. This is a bounded LRU: the least recently
 * used observation is dropped when a new one is recorded past the cap. At the
 * read tool's own truncation budget (2000 lines / 50 KB) the worst-case retained
 * line storage is a few megabytes for a large session.
 */
export const MAX_REPOSITORY_OBSERVATIONS = 128;

/**
 * Cheap deterministic file identity. These are the same signals the session
 * telemetry uses for `repeatedUnchangedReads`, so both agree on what
 * "unchanged" means for a path.
 */
export interface RepositoryFileFingerprint {
	mtimeMs: number;
	size: number;
	isFile: boolean;
}

/** A contiguous line region observed from one repository file. */
export interface RepositoryObservation {
	/** Absolute path the region was physically read from. */
	path: string;
	/** Absolute 0-based index of the first retained line. */
	startLine: number;
	/** Retained lines, exactly as the file's lines were when observed. */
	lines: string[];
	/** Total line count of the file when it was observed. */
	totalFileLines: number;
	/**
	 * Whether `lines` reaches the end of the file. An unbounded request (no
	 * `limit`) is only covered when the observation reaches EOF, because a read
	 * that hit the truncation cap cannot prove it saw the rest of the file.
	 */
	reachesEof: boolean;
}

/** A read request's coverage shape (the read tool's `offset` / `limit`). */
export interface RepositoryReadRequest {
	offset?: number;
	limit?: number;
}

/** Observation counters for session telemetry. */
export interface RepositoryObservationStats {
	/** Read invocations served from a fresh observation (no content read). */
	observationHits: number;
	/** Stored observations discarded because a mutation or a detected change
	 * made them untrustworthy. Not counting LRU eviction or coverage misses. */
	observationInvalidations: number;
}

interface StoredObservation extends RepositoryObservation {
	fingerprint: RepositoryFileFingerprint;
	pathMutationSeq: number;
	uncertaintySeq: number;
}

/** Tools whose successful execution is a known, path-scoped repository
 * mutation. Kept in step with the edit/write tools' `path` argument. */
const PATH_MUTATION_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/** Upper bound on in-flight mutation bookkeeping (guards aborted tool calls). */
const MAX_PENDING_MUTATIONS = 256;

/** Whether two fingerprints describe the same file version. */
export function fingerprintsMatch(a: RepositoryFileFingerprint, b: RepositoryFileFingerprint): boolean {
	return a.isFile === b.isFile && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * How a successfully executed tool can affect repository content.
 *
 * - `path`: a known file mutation carrying an explicit path argument;
 * - `uncertain`: could mutate the workspace but not provably path-local;
 * - `none`: provably does not change repository content.
 *
 * This reuses the existing Aira capability table instead of inventing tool-name
 * heuristics. Note the deliberate difference from the PLAN gate: `unknown`
 * (third-party extension tools) is treated as `uncertain` here, because an
 * observation must fail stale rather than assume an extension is read-only.
 * That only invalidates Aira's own cached evidence; it never blocks a tool.
 */
function classifyToolMutation(toolName: string): "path" | "uncertain" | "none" {
	if (PATH_MUTATION_TOOLS.has(toolName)) {
		return "path";
	}
	switch (classifyAiraCapability(toolName)) {
		case "read-only":
		case "diagnostic":
		case "interaction":
			return "none";
		case "browser": {
			const kind = classifyAiraBrowserOperation(toolName);
			return kind === "observe" || kind === "navigate" ? "none" : "uncertain";
		}
		default:
			// mutating (non-path), process, network, orchestration, unknown.
			return "uncertain";
	}
}

function pathArgument(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	const record = args as Record<string, unknown>;
	const value = record.path ?? record.file_path ?? record.filePath;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Aira-owned repository observation layer. One instance per agent session,
 * shared by the read tool (which records and consults observations) and the
 * session event stream (which reports mutations).
 */
export class RepositoryObservationStore {
	private readonly limit: number;
	private readonly observations = new Map<string, StoredObservation>();
	private readonly pathMutationSeqs = new Map<string, number>();
	private readonly pendingMutations = new Map<string, string | null>();
	private uncertaintySeq = 0;
	private hitCount = 0;
	private invalidationCount = 0;

	constructor(limit = MAX_REPOSITORY_OBSERVATIONS) {
		this.limit = Math.max(1, limit);
	}

	/**
	 * Canonical observation key for a user-supplied path. Uses the same
	 * resolution as the edit/write tools (`resolveToCwd`: `~` expansion, unicode
	 * space normalization, `@` prefix stripping, relative-to-cwd), so a mutation
	 * and the observation it invalidates agree on identity. Case-folds on
	 * Windows, where paths are case-insensitive.
	 */
	observationKey(rawPath: string, cwd: string): string {
		const resolved = resolveToCwd(rawPath, cwd);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	}

	/**
	 * Return a stored region that provably covers the request, or `undefined`.
	 *
	 * Reuse requires all of: a stored observation for the key, an unchanged
	 * fingerprint, an unchanged path mutation sequence, no intervening
	 * uncertainty, and sufficient line coverage. Anything else is a miss and
	 * the caller performs the normal read.
	 */
	lookup(
		key: string,
		fingerprint: RepositoryFileFingerprint | undefined,
		request: RepositoryReadRequest,
	): RepositoryObservation | undefined {
		if (!fingerprint || !fingerprint.isFile) {
			return undefined;
		}
		const stored = this.observations.get(key);
		if (!stored) {
			return undefined;
		}
		if (stored.uncertaintySeq !== this.uncertaintySeq) {
			this.observations.delete(key);
			return undefined;
		}
		if (stored.pathMutationSeq !== (this.pathMutationSeqs.get(key) ?? 0)) {
			this.observations.delete(key);
			return undefined;
		}
		if (!fingerprintsMatch(stored.fingerprint, fingerprint)) {
			// The file changed outside Aira's mutation tracking. Fail stale.
			this.observations.delete(key);
			this.invalidationCount++;
			return undefined;
		}

		const startLine = request.offset ? Math.max(0, request.offset - 1) : 0;
		if (startLine >= stored.totalFileLines) {
			// Let the physical read reproduce the canonical out-of-range error.
			return undefined;
		}
		const localStart = startLine - stored.startLine;
		if (localStart < 0 || localStart >= stored.lines.length) {
			return undefined;
		}
		if (request.limit !== undefined) {
			const endLine = Math.min(startLine + request.limit, stored.totalFileLines);
			if (endLine - stored.startLine > stored.lines.length) {
				return undefined;
			}
		} else if (startLine !== stored.startLine || !stored.reachesEof) {
			// An unbounded request to end of file is only covered by an observation
			// that provably reaches EOF from the same start line.
			return undefined;
		}

		// Refresh LRU position without changing the recorded identity.
		this.observations.delete(key);
		this.observations.set(key, stored);
		this.hitCount++;
		return stored;
	}

	/**
	 * Record a region Aira just read physically. Replaces any prior observation
	 * for the same key and evicts the least recently used entries past the cap.
	 */
	record(key: string, observation: RepositoryObservation, fingerprint: RepositoryFileFingerprint): void {
		if (!fingerprint.isFile || observation.lines.length === 0) {
			return;
		}
		this.observations.delete(key);
		this.observations.set(key, {
			...observation,
			fingerprint,
			pathMutationSeq: this.pathMutationSeqs.get(key) ?? 0,
			uncertaintySeq: this.uncertaintySeq,
		});
		while (this.observations.size > this.limit) {
			const oldest = this.observations.keys().next();
			if (oldest.done) {
				break;
			}
			this.observations.delete(oldest.value);
		}
	}

	/** Discard the observation for one path after a known mutation. */
	invalidatePath(key: string): void {
		if (this.observations.delete(key)) {
			this.invalidationCount++;
		}
	}

	/** Discard every observation when a mutation cannot be proven path-local. */
	invalidateAll(): void {
		if (this.observations.size > 0) {
			this.invalidationCount += this.observations.size;
			this.observations.clear();
		}
	}

	/**
	 * Apply one agent event to the mutation state. Successful, path-carrying
	 * file mutations invalidate that path; successful operations that could
	 * mutate the workspace without a provable path invalidate everything.
	 * Failed operations do not invalidate — a failed edit/write changed nothing.
	 */
	onAgentEvent(event: AgentEvent, cwd: string): void {
		if (event.type === "tool_execution_start") {
			if (PATH_MUTATION_TOOLS.has(event.toolName)) {
				if (this.pendingMutations.size >= MAX_PENDING_MUTATIONS) {
					this.pendingMutations.clear();
				}
				const rawPath = pathArgument(event.args);
				this.pendingMutations.set(
					event.toolCallId,
					rawPath === undefined ? null : this.observationKey(rawPath, cwd),
				);
			}
			return;
		}
		if (event.type !== "tool_execution_end") {
			return;
		}
		const pendingKey = this.pendingMutations.get(event.toolCallId);
		this.pendingMutations.delete(event.toolCallId);
		if (event.isError) {
			return;
		}
		if (PATH_MUTATION_TOOLS.has(event.toolName)) {
			// A Step 6 recovered edit is still an `edit` execution and lands here.
			if (pendingKey) {
				this.invalidatePath(pendingKey);
			} else {
				this.invalidateAll();
			}
			return;
		}
		if (classifyToolMutation(event.toolName) === "uncertain") {
			this.invalidateAll();
		}
	}

	stats(): RepositoryObservationStats {
		return {
			observationHits: this.hitCount,
			observationInvalidations: this.invalidationCount,
		};
	}

	/** Retained observation count (test/debug visibility). */
	size(): number {
		return this.observations.size;
	}
}
