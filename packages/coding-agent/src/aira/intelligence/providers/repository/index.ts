/**
 * Aira intelligence — repository provider.
 *
 * Owns the bounded file-level index of the canonical project root (see
 * `scanner.ts`), its relationship store (`relationships.ts`), its JSON cache
 * (`cache.ts`, under the Aira home — never the workspace), and the git
 * changed-file awareness. The provider is session-scoped, activation is lazy
 * (a background scan at coordinator start), and every operation degrades to
 * "no repository intelligence" instead of failing.
 */

import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { loadRepositoryCache, type RepositoryCacheV1, saveRepositoryCache } from "./cache.ts";
import {
	changedFilesInGit,
	type GitChangeFileStats,
	type GitChangeInfo,
	gitChangeStats,
	RepositoryRelationships,
} from "./relationships.ts";
import {
	type RepositoryFileIndex,
	type RepositoryLanguage,
	scanRepositoryFile,
	walkRepositoryFiles,
} from "./scanner.ts";

export type RepositoryProviderStatus = "uninitialized" | "indexing" | "ready" | "degraded" | "unsupported";

export interface RepositoryProviderStatusInfo {
	status: RepositoryProviderStatus;
	filesIndexed: number;
	lastScanAt?: number;
	lastScanDurationMs?: number;
	cacheLoaded: boolean;
	error?: string;
	changes: { available: boolean; count: number };
}

export interface RepositoryProviderOptions {
	/** Cache directory (Aira home cache); undefined disables persistence. */
	cacheDir?: string;
	/** Absolute paths must live under the project root to be indexed. */
	maxFiles?: number;
}

/**
 * Repository intelligence provider. All path inputs/outputs are absolute on
 * the public surface; the internal index is repo-relative (forward slashes).
 */
export class RepositoryProvider {
	private readonly relationships = new RepositoryRelationships();
	private readonly cacheDir: string | undefined;
	private readonly maxFiles: number | undefined;
	private status: RepositoryProviderStatus = "uninitialized";
	private filesIndexed = 0;
	private lastScanAt: number | undefined;
	private lastScanDurationMs: number | undefined;
	private cacheLoaded = false;
	private error: string | undefined;
	private changeInfo: GitChangeInfo = { changed: undefined };
	private scanPromise: Promise<void> | undefined;
	private readonly root: string;
	/** Absolute paths edited this session (for change awareness without git churn). */
	private readonly sessionEdited = new Set<string>();

	constructor(root: string, options: RepositoryProviderOptions = {}) {
		this.root = root;
		this.cacheDir = options.cacheDir;
		this.maxFiles = options.maxFiles;
	}

	get projectRoot(): string {
		return this.root;
	}

	/** Start the provider: load cache, bind persisted evidence, refresh in background. */
	async activate(): Promise<void> {
		if (this.cacheDir) {
			const cached = await loadRepositoryCache(this.cacheDir, this.root);
			if (cached && cached.files.length > 0) {
				this.relationships.rebuild(cached.files);
				this.filesIndexed = cached.files.length;
				this.cacheLoaded = true;
				this.status = "ready";
			}
		}
		this.scanPromise = this.refresh();
	}

	/** Wait for the initial background scan to settle (tests). */
	async settled(): Promise<void> {
		await this.scanPromise;
	}

	/** Refresh the index: walk, rescan stale/new files, rebind, persist. */
	async refresh(): Promise<void> {
		if (this.status === "indexing") {
			return;
		}
		this.status = "indexing";
		const startedAt = Date.now();
		try {
			const { files } = await walkRepositoryFiles(this.root, { maxFiles: this.maxFiles });
			const known = new Map(this.relationships.files().map((f) => [f.path, f]));
			const seen = new Set<string>();
			for (const relativePath of files) {
				seen.add(relativePath);
				const existing = known.get(relativePath);
				if (existing) {
					// Cheap reuse: same mtime+size means identical evidence.
					let current: Awaited<ReturnType<typeof stat>> | undefined;
					try {
						current = await stat(this.abs(relativePath));
					} catch {
						current = undefined;
					}
					if (current && current.mtimeMs === existing.mtimeMs && current.size === existing.sizeBytes) {
						this.relationships.upsert(existing);
						continue;
					}
				}
				const scanned = await scanRepositoryFile(this.root, relativePath);
				if (scanned) {
					this.relationships.upsert(scanned);
				}
			}
			const stale = this.relationships.files().filter((f) => !seen.has(f.path));
			for (const file of stale) {
				this.relationships.remove(file.path);
			}
			this.filesIndexed = this.relationships.size;
			this.lastScanAt = Date.now();
			this.lastScanDurationMs = this.lastScanAt - startedAt;
			this.status = this.relationships.size === 0 ? "degraded" : "ready";
			this.error = undefined;
			if (this.cacheDir) {
				await saveRepositoryCache(this.cacheDir, this.root, this.serialize());
			}
		} catch (scanError) {
			this.status = "degraded";
			this.error = scanError instanceof Error ? scanError.message : String(scanError);
		}
	}

	/** Refresh changed-file awareness from git (bounded, failure-tolerant). */
	async refreshChanges(): Promise<void> {
		const info = await changedFilesInGit(this.root);
		this.changeInfo = info;
	}

	/**
	 * Bounded per-file change stats for the Phase 8 verifier (paths, status,
	 * added/deleted line counts). Undefined when git is unavailable. Refreshes
	 * the cached change list so verifier input is never stale by construction.
	 */
	async verificationChanges(): Promise<GitChangeFileStats[] | undefined> {
		try {
			const stats = await gitChangeStats(this.root);
			if (stats !== undefined) {
				this.changeInfo = { changed: stats.map((file) => file.path) };
			}
			return stats;
		} catch {
			return undefined;
		}
	}

	/**
	 * Bounded working-set stats for UI projections (Phase 12 Workbench). Same
	 * canonical git seam as `verificationChanges`; UI callers coalesce through
	 * the Workbench controller so git processes never run at render frequency.
	 */
	async workingSet(): Promise<GitChangeFileStats[] | undefined> {
		return this.verificationChanges();
	}

	/** Mark an edited absolute path so change awareness works without git churn. */
	noteEdit(absolutePath: string): void {
		const rel = this.toRelative(absolutePath);
		if (rel) {
			this.sessionEdited.add(rel);
		}
	}

	/** Changed paths relative to the project root, or undefined when git is unavailable. */
	changedPaths(): string[] | undefined {
		const git = this.changeInfo.changed;
		if (git) {
			return [...git];
		}
		return this.sessionEdited.size > 0 ? [...this.sessionEdited] : undefined;
	}

	/** Absolute paths of git/session changes (prefixed with the project root). */
	changedAbsolutePaths(): string[] {
		const changed = this.changedPaths();
		if (!changed) {
			return [];
		}
		return changed.map((rel) => this.abs(rel));
	}

	/** Incrementally re-index one absolute path after an edit/write. */
	async reindexFile(absolutePath: string): Promise<void> {
		const rel = this.toRelative(absolutePath);
		if (!rel) {
			return;
		}
		const scanned = await scanRepositoryFile(this.root, rel);
		if (scanned) {
			this.relationships.upsert(scanned);
			this.filesIndexed = this.relationships.size;
		} else {
			this.relationships.remove(rel);
		}
	}

	/** Ranked likely-file discovery for a free-text objective. */
	discover(query: string, options?: { limit?: number }) {
		return this.relationships.discover(query, options);
	}

	/**
	 * Bounded symbols from the working set (changed/edited paths) for UI
	 * projections (Phase 12 Workbench "Relevant Symbols"). Derived from the
	 * cached repository index — zero extra scans, zero git processes.
	 */
	relevantSymbols(limit = 12): Array<{ path: string; name: string; kind: string; line: number }> {
		const files = new Map(this.relationships.files().map((f) => [f.path, f]));
		const paths = this.changeInfo.changed ?? [...this.sessionEdited];
		const rows: Array<{ path: string; name: string; kind: string; line: number }> = [];
		for (const rel of paths) {
			const file = files.get(rel);
			if (!file) continue;
			for (const symbol of file.symbols) {
				rows.push({ path: file.path, name: symbol.name, kind: symbol.kind, line: symbol.line });
				if (rows.length >= limit) return rows;
			}
		}
		return rows;
	}

	/** Absolute paths that import the given absolute path. */
	importedBy(absolutePath: string): string[] {
		const rel = this.toRelative(absolutePath);
		if (!rel) {
			return [];
		}
		return this.relationships.importedByPaths(rel).map((p) => this.abs(p));
	}

	/** Absolute paths the given absolute path imports (resolved relative targets). */
	imports(absolutePath: string): string[] {
		const rel = this.toRelative(absolutePath);
		if (!rel) {
			return [];
		}
		return this.relationships.importTargets(rel).map((p) => this.abs(p));
	}

	/** Source/test counterparts (absolute) for an absolute path, when they exist in the index. */
	counterparts(absolutePath: string): string[] {
		const rel = this.toRelative(absolutePath);
		if (!rel) {
			return [];
		}
		return this.relationships.counterparts(rel).map((p) => this.abs(p));
	}

	/** File evidence (repo-relative) for an absolute path. */
	fileFor(absolutePath: string): RepositoryFileIndex | undefined {
		const rel = this.toRelative(absolutePath);
		return rel ? this.relationships.file(rel) : undefined;
	}

	/** Every indexed language present in the project. */
	languages(): RepositoryLanguage[] {
		const langs = new Set<RepositoryLanguage>();
		for (const file of this.relationships.files()) {
			langs.add(file.language);
		}
		return [...langs].sort();
	}

	/** Per-language file counts (for health/context, bounded). */
	languageCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const file of this.relationships.files()) {
			counts[file.language] = (counts[file.language] ?? 0) + 1;
		}
		return counts;
	}

	/** Compact one-line working-set context for the coordinator. */
	workingSetSummary(absolutePaths: readonly string[], opts?: { limit?: number }): string {
		const limit = opts?.limit ?? 8;
		const lines: string[] = [];
		for (const absolutePath of absolutePaths.slice(0, limit)) {
			const rel = this.toRelative(absolutePath);
			if (!rel) {
				continue;
			}
			const file = this.relationships.file(rel);
			const parts = [rel];
			if (file) {
				if (file.isTest) parts.push("(test)");
				const cps = this.relationships.counterparts(rel);
				if (cps.length > 0) parts.push(`— counterpart(s): ${cps.join(", ")}`);
				const importers = this.relationships.importedByPaths(rel);
				if (importers.length > 0) parts.push(`— imported by ${importers.length}`);
			}
			lines.push(parts.join(" "));
		}
		return lines.join("\n");
	}

	/** Overall status snapshot for health surfaces. */
	statusInfo(): RepositoryProviderStatusInfo {
		return {
			status: this.status,
			filesIndexed: this.filesIndexed,
			lastScanAt: this.lastScanAt,
			lastScanDurationMs: this.lastScanDurationMs,
			cacheLoaded: this.cacheLoaded,
			error: this.error,
			changes: {
				available: this.changeInfo.changed !== undefined,
				count: this.changedPaths()?.length ?? 0,
			},
		};
	}

	/** Serialize for persistence. */
	private serialize(): RepositoryCacheV1 {
		return {
			version: 1,
			root: this.root,
			scannedAt: this.lastScanAt ?? Date.now(),
			files: this.relationships.files(),
		};
	}

	/** Absolute → repo-relative (posix), or undefined when outside the root. */
	private toRelative(absolutePath: string): string | undefined {
		const rel = relative(this.root, absolutePath).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..") || rel.includes("\0")) {
			return undefined;
		}
		return rel;
	}

	/** Repo-relative → absolute. */
	private abs(relativePath: string): string {
		const sep = this.root.includes("\\") ? "\\" : "/";
		return `${this.root}${sep}${relativePath.replace(/\//g, sep)}`;
	}
}
