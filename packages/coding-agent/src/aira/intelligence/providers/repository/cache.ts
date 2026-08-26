/**
 * Aira intelligence — repository index persistence.
 *
 * The repository index is cacheable and easy to invalidate: a single JSON
 * file per project under the Aira home cache (`~/.aira/agent/cache/…`),
 * never inside the workspace (so repository intelligence never mutates the
 * project, PLAN included). Invalidation is per-file mtime/size compare on
 * the next scan.
 *
 * Persistence decision (Phase 5): JSON-under-the-Aira-home, NOT SQLite.
 * The reference implementation's better-sqlite3 dependency fails to build
 * on this verified Node 25.9.0 / macOS arm64 baseline (no prebuilt binary,
 * node-gyp fails against the V8 headers). Phase 5's file-level index has no
 * query workload that justifies a native addon, and Node 25 ships a
 * built-in `node:sqlite` (zero-dependency, FTS5-capable) if a later phase's
 * graph genuinely needs SQL. Storage stays behind the provider boundary, so
 * this choice is replaceable without touching consumers.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryFileIndex } from "./scanner.ts";

export const REPOSITORY_CACHE_VERSION = 1;

export interface RepositoryCacheV1 {
	version: 1;
	root: string;
	scannedAt: number;
	files: RepositoryFileIndex[];
}

/** Stable per-project cache key (hash of the project root). */
export function repositoryCacheKey(root: string): string {
	return createHash("sha1").update(root).digest("hex").slice(0, 16);
}

export function repositoryCachePath(cacheDir: string, root: string): string {
	return join(cacheDir, "repos", `${repositoryCacheKey(root)}.json`);
}

/** Load the persisted index for a project root, if present and readable. */
export async function loadRepositoryCache(cacheDir: string, root: string): Promise<RepositoryCacheV1 | undefined> {
	try {
		const raw = await readFile(repositoryCachePath(cacheDir, root), "utf8");
		const parsed = JSON.parse(raw) as Partial<RepositoryCacheV1>;
		if (parsed.version !== REPOSITORY_CACHE_VERSION || parsed.root !== root || !Array.isArray(parsed.files)) {
			return undefined;
		}
		return {
			version: REPOSITORY_CACHE_VERSION,
			root: parsed.root,
			scannedAt: typeof parsed.scannedAt === "number" ? parsed.scannedAt : Date.now(),
			files: parsed.files,
		};
	} catch {
		return undefined;
	}
}

/** Persist the index (best-effort; a failed write only degrades the cache). */
export async function saveRepositoryCache(cacheDir: string, root: string, cache: RepositoryCacheV1): Promise<void> {
	try {
		await mkdir(join(cacheDir, "repos"), { recursive: true });
		const path = repositoryCachePath(cacheDir, root);
		const tmp = `${path}.tmp`;
		const payload = JSON.stringify({ ...cache, root });
		await writeFile(tmp, payload, "utf8");
		await rename(tmp, path);
	} catch {
		// Cache persistence is best-effort; intelligence still works in memory.
	}
}
