/**
 * Aira intelligence — findings model and freshness contract.
 *
 * Every piece of evidence Aira collects (LSP diagnostics, repository
 * signals) normalizes into a finding tied to a path, source, provider,
 * severity, collection time, and freshness verdict. The store is the single
 * session-scoped home for evidence; coordinators and context packs read from
 * it. Nothing presents a stale finding as current truth — path freshness is
 * re-checked on read (file mtime vs collection time), and a cleared/re-scanned
 * path replaces its old findings atomically.
 *
 * The freshness kernel mirrors the reference implementation's lesson: one
 * comparator ("was the file modified after the reference timestamp?"), a
 * shared mtime drift tolerance, and an explicit `indeterminate` verdict when
 * no mtime evidence exists — never a guessed "fresh".
 */
import { createHash } from "node:crypto";

export type AiraFindingSeverity = "error" | "warning" | "information" | "hint" | "other";
export type AiraFindingSource = "lsp" | "repository" | "host";
export type AiraFreshnessVerdict = "fresh" | "stale" | "indeterminate";

/** 1-based line and 0-based character, matching LSP positions. */
export interface AiraFindingPosition {
	line: number;
	character: number;
}

export interface AiraFinding {
	/** Stable identity across re-collections (path + source + provider + code + start line + message hash). */
	readonly id: string;
	/** Absolute, normalized path the finding applies to. */
	readonly path: string;
	readonly source: AiraFindingSource;
	/** Provider id, e.g. "typescript", "pyright", "repository". */
	readonly providerId: string;
	readonly severity: AiraFindingSeverity;
	readonly message: string;
	readonly code?: string | number;
	readonly range?: { start: AiraFindingPosition; end: AiraFindingPosition };
	/** LSP document version at collection time, when known. */
	readonly version?: number;
	/** Collection time (ms since epoch). */
	readonly at: number;
	/** Session turn during which it was collected. */
	readonly turn: number;
	/** Freshness verdict at insertion; refreshable by `refreshPathFreshness`. */
	freshness: AiraFreshnessVerdict;
}

/** Shared mtime drift tolerance (matches the reference: 50ms, Windows mtime skew). */
export const AIRA_MTIME_DRIFT_TOLERANCE_MS = 50;

/**
 * Freshness kernel: compare an observed file mtime against a reference
 * timestamp (scan/collection). `mtimeMs === undefined` means no mtime evidence
 * → `indeterminate` (caller maps policy; never guess fresh).
 */
export function freshnessFromMtime(input: {
	mtimeMs: number | undefined;
	referenceMs: number;
	toleranceMs?: number;
}): AiraFreshnessVerdict {
	const tolerance = input.toleranceMs ?? AIRA_MTIME_DRIFT_TOLERANCE_MS;
	if (input.mtimeMs === undefined) {
		return "indeterminate";
	}
	return input.mtimeMs > input.referenceMs + tolerance ? "stale" : "fresh";
}

/** Is this finding a hard blocker (error severity)? Advisories never block. */
export function isAiraFindingBlocking(finding: AiraFinding): boolean {
	return finding.severity === "error";
}

/** Compact stable identity for a finding. */
export function airaFindingId(input: {
	path: string;
	source: AiraFindingSource;
	providerId: string;
	code?: string | number;
	line?: number;
	message: string;
}): string {
	const raw = JSON.stringify([
		input.path,
		input.source,
		input.providerId,
		String(input.code ?? ""),
		input.line ?? 0,
		input.message,
	]);
	return createHash("sha1").update(raw).digest("base64url").slice(0, 12);
}

/** Compact severity tier label for summaries. */
function severityTier(severity: AiraFindingSeverity): string {
	if (severity === "error") return "E";
	if (severity === "warning") return "W";
	return "I";
}

/**
 * A one-line-per-path diagnostic summary for context injection (bounded, and
 * excluding findings already marked stale). Presentation lives outside the
 * store so the store stays storage-only.
 */
export function summarizeFindingsForPaths(
	store: AiraFindingsStore,
	paths: readonly string[],
	opts?: { maxPaths?: number; maxPerPath?: number },
): string {
	const maxPaths = opts?.maxPaths ?? 8;
	const maxPerPath = opts?.maxPerPath ?? 5;
	const lines: string[] = [];
	for (const path of paths.slice(0, maxPaths)) {
		const found = store.forPath(path);
		if (found.length === 0) {
			continue;
		}
		const stale = found.filter((f) => f.freshness === "stale").length;
		const notStale = found.filter((f) => f.freshness !== "stale");
		const fresh = notStale.slice(0, maxPerPath);
		const omittedNote = notStale.length > fresh.length ? ` (+${notStale.length - fresh.length} more)` : "";
		const staleNote = stale > 0 ? ` (+${stale} stale)` : "";
		const items = fresh
			.map((f) => {
				const kind = severityTier(f.severity);
				return `${kind}:${f.message}`;
			})
			.join(" | ");
		lines.push(`${path}${staleNote}${omittedNote} — ${items}`);
	}
	return lines.join("\n");
}

/**
 * Session-scoped bounded findings store. Keyed by path; re-collecting a path
 * replaces its old findings. Path freshness is refreshed lazily on read and
 * eagerly on the coordinator's edit events.
 */
export class AiraFindingsStore {
	private readonly findings: Map<string, AiraFinding[]> = new Map();
	private readonly order: string[] = [];
	private readonly options: { maxFindings?: number };
	private turn = 0;

	constructor(options: { maxFindings?: number } = {}) {
		this.options = options;
	}

	/** Advance the session turn counter. */
	setTurn(turn: number): void {
		this.turn = turn;
	}

	get currentTurn(): number {
		return this.turn;
	}

	/** Replace all findings for a path (collection for a newer scan). */
	replaceForPath(
		path: string,
		findings: Omit<AiraFinding, "id" | "at" | "turn" | "freshness">[],
		collectedAt = Date.now(),
	): void {
		this.clearPath(path);
		if (findings.length === 0) {
			return;
		}
		const value: AiraFinding[] = findings.map((f) => ({
			...f,
			path,
			id: airaFindingId({
				path,
				source: f.source,
				providerId: f.providerId,
				code: f.code,
				line: f.range?.start.line,
				message: f.message,
			}),
			at: collectedAt,
			turn: this.turn,
			freshness: "fresh",
		}));
		this.findings.set(path, value);
		this.order.push(path);
		this.enforceCap();
	}

	/** Drop all findings for a path (edit or rescan). */
	clearPath(path: string): void {
		if (!this.findings.delete(path)) {
			return;
		}
		const idx = this.order.indexOf(path);
		if (idx !== -1) {
			this.order.splice(idx, 1);
		}
	}

	/**
	 * All findings for a path. When mtime evidence is supplied the path's
	 * freshness is re-checked against it; otherwise the stored verdicts are
	 * returned unchanged (never silently downgraded to "indeterminate").
	 */
	forPath(path: string, mtimeMs?: number): AiraFinding[] {
		const found = this.findings.get(path);
		if (!found) {
			return [];
		}
		if (mtimeMs !== undefined) {
			this.refreshPathFreshness(path, mtimeMs);
		}
		return [...(this.findings.get(path) ?? [])];
	}

	/** Refresh one path's findings against a freshly-stated mtime. */
	private refreshPathFreshness(path: string, mtimeMs: number | undefined): void {
		const found = this.findings.get(path);
		if (!found) {
			return;
		}
		if (mtimeMs !== undefined) {
			const scannedAt = Math.max(0, ...found.map((f) => f.at));
			const verdict = freshnessFromMtime({ mtimeMs, referenceMs: scannedAt });
			for (const f of found) {
				f.freshness = verdict;
			}
		}
	}

	/** All findings across paths (freshness not auto-refreshed; use `refreshAll`). */
	all(): AiraFinding[] {
		return this.order.flatMap((path) => this.findings.get(path) ?? []);
	}

	/** Refresh freshness for every stored path against current file mtimes. */
	refreshAll(getMtimeMs: (path: string) => number | undefined): AiraFindingsStoreResult {
		let stale = 0;
		for (const path of [...this.order]) {
			this.refreshPathFreshness(path, getMtimeMs(path));
			for (const f of this.findings.get(path) ?? []) {
				if (f.freshness === "stale") {
					stale += 1;
				}
			}
		}
		return { total: this.size, stale };
	}

	/** Findings collected during the given turn (for turn-end delivery). */
	forTurn(turn: number): AiraFinding[] {
		return this.all().filter((f) => f.turn === turn);
	}

	/** Total stored findings. */
	get size(): number {
		let n = 0;
		for (const list of this.findings.values()) {
			n += list.length;
		}
		return n;
	}

	/** Paths that currently carry at least one finding. */
	get paths(): string[] {
		return [...this.order];
	}

	/** Per-severity counts across stored findings. */
	counts(): { errors: number; warnings: number; other: number; paths: number } {
		let errors = 0;
		let warnings = 0;
		let other = 0;
		for (const f of this.all()) {
			if (f.severity === "error") errors += 1;
			else if (f.severity === "warning") warnings += 1;
			else other += 1;
		}
		return { errors, warnings, other, paths: this.order.length };
	}

	private enforceCap(): void {
		const max = this.options.maxFindings ?? 500;
		while (this.size > max && this.order.length > 0) {
			this.clearPath(this.order[0] ?? "");
		}
	}
}

export interface AiraFindingsStoreResult {
	total: number;
	stale: number;
}
