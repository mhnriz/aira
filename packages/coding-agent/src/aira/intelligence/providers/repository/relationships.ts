/**
 * Aira intelligence — repository relationships.
 *
 * The smallest representation that supports ambient behavior:
 *
 * ```text
 * imports       resolved relative imports (imports / imported-by)
 * counterparts  source ↔ test counterpart paths (path heuristics)
 * changes       git changed files (status --porcelain; respects .gitignore)
 * lexical       identifier tokens → files, for "likely files" discovery
 * ```
 *
 * No code graph: no caller/callee edges, no entity resolution, no route/screen
 * heuristics. Those were evaluated against the reference implementation and
 * deferred — the foundation answers "which files matter to this objective"
 * with file-level evidence that is cheap, fresh, and easy to invalidate.
 */

import { execFile } from "node:child_process";
import { dirname, extname, join, normalize, relative } from "node:path";
import type { RepositoryFileIndex, RepositorySymbol } from "./scanner.ts";

const RESOLVABLE_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".py",
	".rs",
	".go",
	".c",
	".h",
	".cpp",
	".hpp",
];

/**
 * A file-level relationship store built from a scan. Owns the by-path index,
 * forward/reverse import edges, source↔test counterpart edges, and a
 * lexical token index for targeted discovery. All lookups are synchronous;
 * building/updating happens in the provider.
 */
export class RepositoryRelationships {
	private readonly byPath = new Map<string, RepositoryFileIndex>();
	private readonly importsOf = new Map<string, string[]>();
	private readonly importedBy = new Map<string, string[]>();
	private readonly counterpartsOf = new Map<string, string[]>();
	private readonly lexical = new RepositoryLexicalIndex();

	/** Replace the whole index with a fresh scan result. */
	rebuild(files: RepositoryFileIndex[]): void {
		this.byPath.clear();
		this.importsOf.clear();
		this.importedBy.clear();
		this.counterpartsOf.clear();
		this.lexical.clear();
		for (const file of files) {
			this.byPath.set(file.path, file);
		}
		for (const file of files) {
			this.indexFile(file.path);
		}
		this.rebuildImportedBy();
	}

	/** Incrementally update one file's evidence (post-edit / post-scan). */
	upsert(file: RepositoryFileIndex): void {
		const existed = this.byPath.has(file.path);
		this.byPath.set(file.path, file);
		this.indexFile(file.path);
		if (!existed) {
			// A new file can become the target of existing imports/counterparts.
			for (const other of this.byPath.values()) {
				if (other.path !== file.path) {
					this.indexFile(other.path);
				}
			}
		}
		// importedBy is cross-file state; recompute it wholesale (bounded).
		this.rebuildImportedBy();
	}

	/** Remove a file's evidence (deleted). */
	remove(path: string): void {
		this.byPath.delete(path);
		this.importsOf.delete(path);
		this.importedBy.delete(path);
		this.counterpartsOf.delete(path);
		this.lexical.remove(path);
		this.rebuildImportedBy();
	}

	/** Per-file index lookup. */
	file(path: string): RepositoryFileIndex | undefined {
		return this.byPath.get(path);
	}

	get size(): number {
		return this.byPath.size;
	}

	files(): RepositoryFileIndex[] {
		return [...this.byPath.values()];
	}

	/** Files that import the given path (imported-by). */
	importedByPaths(path: string): string[] {
		return [...(this.importedBy.get(path) ?? [])];
	}

	/** Files the given path imports (resolved relative targets). */
	importTargets(path: string): string[] {
		return [...(this.importsOf.get(path) ?? [])];
	}

	/** Source/test counterpart paths for a path. */
	counterparts(path: string): string[] {
		return [...(this.counterpartsOf.get(path) ?? [])];
	}

	/**
	 * Ranked likely-file discovery for a free-text objective: tokenize the
	 * query, score files whose symbol names or basenames share tokens, and
	 * return the top matches with the matched symbols.
	 */
	discover(query: string, options?: { limit?: number }): Array<{ path: string; score: number; symbols: string[] }> {
		return this.lexical.discover(query, (path) => this.byPath.get(path)?.symbols ?? [], options?.limit ?? 8);
	}

	private indexFile(path: string): void {
		this.importsOf.delete(path);
		this.counterpartsOf.delete(path);
		this.lexical.remove(path);
		const file = this.byPath.get(path);
		if (!file) {
			return;
		}

		const targets: string[] = [];
		for (const specifier of file.imports) {
			const resolved = resolveImportTarget(path, specifier, this.byPath);
			if (resolved) {
				targets.push(resolved);
			}
		}
		this.importsOf.set(path, [...new Set(targets)]);

		for (const counterpart of sourceTestCounterparts(path)) {
			if (this.byPath.has(counterpart)) {
				const list = this.counterpartsOf.get(path) ?? [];
				if (!list.includes(counterpart)) {
					list.push(counterpart);
				}
				this.counterpartsOf.set(path, list);
			}
		}

		this.lexical.index(path, file);
	}

	/** Recompute the cross-file imported-by edges from the per-file import targets. */
	private rebuildImportedBy(): void {
		this.importedBy.clear();
		for (const [path, targets] of this.importsOf) {
			for (const target of targets) {
				if (!this.byPath.has(target)) {
					continue;
				}
				const list = this.importedBy.get(target) ?? [];
				if (!list.includes(path)) {
					list.push(path);
				}
				this.importedBy.set(target, list);
			}
		}
	}
}

/** Bounded identifier-token index answering "which files mention this objective". */
export class RepositoryLexicalIndex {
	private readonly tokens = new Map<string, Map<string, number>>();

	clear(): void {
		this.tokens.clear();
	}

	/** Add one file's symbol/basename tokens. */
	index(path: string, file: RepositoryFileIndex): void {
		const weights = new Map<string, number>();
		const add = (token: string, weight: number) => {
			if (token.length < 2) {
				return;
			}
			weights.set(token, (weights.get(token) ?? 0) + weight);
		};
		for (const symbol of file.symbols) {
			for (const token of tokenize(symbol.name)) {
				add(token, symbol.kind === "function" ? 3 : 2);
			}
		}
		for (const token of tokenize(file.path)) {
			add(token, 1);
		}
		for (const [token, weight] of weights) {
			const posting = this.tokens.get(token) ?? new Map();
			posting.set(path, (posting.get(path) ?? 0) + weight);
			this.tokens.set(token, posting);
		}
	}

	/** Remove one file's tokens. */
	remove(path: string): void {
		for (const posting of this.tokens.values()) {
			posting.delete(path);
		}
	}

	/** Ranked discovery over the token index. */
	discover(
		query: string,
		symbolsOf: (path: string) => RepositorySymbol[],
		limit: number,
	): Array<{ path: string; score: number; symbols: string[] }> {
		const queryTokens = tokenize(query);
		if (queryTokens.size === 0) {
			return [];
		}
		const scores = new Map<string, { score: number; symbols: string[] }>();
		for (const token of queryTokens) {
			const posting = this.tokens.get(token);
			if (!posting) {
				continue;
			}
			for (const [path, weight] of posting) {
				const entry = scores.get(path) ?? { score: 0, symbols: [] };
				entry.score += weight;
				const symbol = symbolsOf(path).find((s) => tokenize(s.name).has(token));
				if (symbol) {
					entry.symbols.push(symbol.name);
				}
				scores.set(path, entry);
			}
		}
		return [...scores.entries()]
			.map(([path, entry]) => ({ path, score: entry.score, symbols: [...new Set(entry.symbols)].slice(0, 3) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}
}

/** Resolve a relative import specifier against the importing file and the repo index. */
export function resolveImportTarget(
	sourcePath: string,
	specifier: string,
	knownPaths: ReadonlyMap<string, RepositoryFileIndex> | ReadonlySet<string>,
): string | undefined {
	if (!specifier.startsWith(".")) {
		return undefined;
	}
	const base = normalize(join(dirname(sourcePath), specifier)).replace(/\\/g, "/");
	const candidates = buildImportCandidates(base);
	const has = (p: string) => (knownPaths instanceof Set ? knownPaths.has(p) : knownPaths.has(p));
	return candidates.find(has);
}

function buildImportCandidates(base: string): string[] {
	const ext = extname(base);
	const candidates: string[] = [];
	if (ext) {
		candidates.push(base);
	} else {
		for (const candidateExt of RESOLVABLE_EXTENSIONS) {
			candidates.push(`${base}${candidateExt}`);
		}
		for (const candidateExt of RESOLVABLE_EXTENSIONS) {
			candidates.push(`${base}/index${candidateExt}`);
		}
	}
	return candidates.map((candidate) => candidate.replace(/^\.\//, ""));
}

/**
 * Source/test counterpart path candidates, modeled on the reference
 * implementation's rules plus the common Python `tests/test_x.py` naming:
 * `x.ts ↔ x.test.ts`, `src/x.py ↔ tests/x.py`, `tests/test_x.py ↔ lib/x.py`,
 * and their inverses. Callers intersect with the actual index.
 */
export function sourceTestCounterparts(path: string): string[] {
	const extMatch = path.match(/\.[A-Za-z0-9]+$/);
	const ext = extMatch?.[0] ?? ".ts";
	const withoutExt = path.slice(0, path.length - ext.length);
	const candidates = new Set<string>();
	const fileName = withoutExt.split("/").at(-1) ?? withoutExt;
	const dir = withoutExt.split("/").slice(0, -1).join("/");

	if (isTestLike(path)) {
		// Strip .test/.spec suffixes and the tests/ tree prefix.
		candidates.add(`${withoutExt.replace(/\.(test|spec)$/, "")}${ext}`);
		for (const prefix of ["test/", "tests/", "__tests__/"]) {
			if (path.startsWith(prefix)) {
				candidates.add(`${withoutExt.slice(prefix.length)}${ext}`);
			}
		}
		// Python convention: tests/test_x.py → x.py next to src/lib/app.
		if (/^(?:test|spec)_/.test(fileName)) {
			const name = fileName.replace(/^(?:test|spec)_/, "");
			for (const base of [dir, "src", "lib", "app", ""]) {
				candidates.add(`${base === "" ? "" : `${base}/`}${name}${ext}`);
			}
		}
	} else {
		candidates.add(`${withoutExt}.test${ext}`);
		candidates.add(`${withoutExt}.spec${ext}`);
		if (path.startsWith("src/")) {
			const rel = withoutExt.slice(4);
			candidates.add(`test/${rel}.test${ext}`);
			candidates.add(`tests/${rel}.test${ext}`);
		}
	}
	return [...candidates].filter((candidate) => candidate !== path);
}

function isTestLike(path: string): boolean {
	return /\.(test|spec)\.[^/]+$/.test(path) || /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(path);
}

/** Tokenize an identifier-ish text into lowercase pieces (camelCase/snake/kebab/dotted splits). */
export function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
	for (const match of text.matchAll(identifierPattern)) {
		const raw = match[0];
		const pieces = raw
			.split(/[\s._/-]+/)
			.flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
			.flatMap((part) => part.split(/(?<=[A-Z])(?=[A-Z][a-z])/))
			.map((part) => part.toLowerCase());
		for (const piece of pieces) {
			if (piece.length >= 2) {
				tokens.add(piece);
			}
		}
		tokens.add(raw.toLowerCase());
	}
	return tokens;
}

export interface GitChangeInfo {
	/** Paths changed in the working tree (relative to root), or undefined when git is unavailable. */
	changed: string[] | undefined;
	error?: string;
}

export interface GitChangeFileStats {
	/** Path relative to the project root. */
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	/** Added lines (git numstat; 0 for untracked/deleted-without-numstat). */
	added: number;
	/** Deleted lines (git numstat; 0 for untracked). */
	deleted: number;
}

/**
 * Bounded per-file change stats (`git status --porcelain` + `git diff
 * --numstat`). Consumed by the Phase 8 verifier for the change summary,
 * scope-drift input, and change-identity hashing. Paths are relative to the
 * root; the list is capped; git errors degrade to `undefined` results.
 */
export async function gitChangeStats(root: string, timeoutMs = 3000): Promise<GitChangeFileStats[] | undefined> {
	const status = await changedFilesInGit(root, timeoutMs);
	if (!status.changed) {
		return undefined;
	}
	const numstat = await new Promise<string>((resolvePromise) => {
		execFile(
			"git",
			["diff", "--numstat", "--no-renames"],
			{ cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout) => {
				resolvePromise(error ? "" : stdout);
			},
		);
	});
	const numstatByPath = new Map<string, { added: number; deleted: number }>();
	for (const line of numstat.split("\n")) {
		const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim());
		if (!match) {
			continue;
		}
		const path = normalize(match[3]).replace(/\\/g, "/");
		numstatByPath.set(path, { added: Number(match[1]), deleted: Number(match[2]) });
	}
	const files: GitChangeFileStats[] = [];
	const porcelain = (await gitPorcelainEntries(root, timeoutMs)) ?? [];
	for (const entry of porcelain) {
		const stats = numstatByPath.get(entry.path);
		files.push({
			path: entry.path,
			status:
				entry.kind === "??"
					? "untracked"
					: entry.kind.startsWith("A")
						? "added"
						: entry.kind.startsWith("D")
							? "deleted"
							: entry.kind.startsWith("R")
								? "renamed"
								: "modified",
			added: stats?.added ?? 0,
			deleted: stats?.deleted ?? 0,
		});
	}
	return files;
}

interface GitPorcelainEntry {
	path: string;
	kind: string;
}

async function gitPorcelainEntries(root: string, timeoutMs: number): Promise<GitPorcelainEntry[] | undefined> {
	let stdout: string;
	try {
		stdout = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
			cwd: root,
			timeout: timeoutMs,
			maxBuffer: 1024 * 1024,
		});
	} catch {
		return undefined;
	}
	const entries: GitPorcelainEntry[] = [];
	for (const line of stdout.split("\n")) {
		// Porcelain v1 (no trim!): `XY <path>` (e.g. " M src/a.ts", "?? src/b.ts",
		// "R  old -> new"); the path starts at index 3.
		if (line.length < 4) {
			continue;
		}
		const kind = line.slice(0, 2);
		const pathPart = line.slice(3).split(" -> ").at(-1) ?? "";
		const rel = normalize(pathPart).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..")) {
			continue;
		}
		const relToRoot = normalize(relative(root, join(root, rel))).replace(/\\/g, "/");
		if (relToRoot && !relToRoot.startsWith("..") && entries.length < 200) {
			entries.push({ path: relToRoot, kind });
		}
	}
	return entries;
}

/** Changed files in the working tree via `git status --porcelain` (respects .gitignore). */
export async function changedFilesInGit(root: string, timeoutMs = 3000): Promise<GitChangeInfo> {
	try {
		const entries = await gitPorcelainEntries(root, timeoutMs);
		if (entries === undefined) {
			return { changed: undefined, error: "git status failed" };
		}
		return { changed: entries.map((entry) => entry.path) };
	} catch (error) {
		return { changed: undefined, error: error instanceof Error ? error.message : String(error) };
	}
}

function execFileAsync(
	command: string,
	args: string[],
	options: { cwd: string; timeout?: number; maxBuffer: number },
): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(command, args, options, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolvePromise(stdout);
		});
	});
}
