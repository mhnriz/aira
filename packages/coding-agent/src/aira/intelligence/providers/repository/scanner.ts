/**
 * Aira intelligence — repository file scanner.
 *
 * A bounded, incremental-friendly walk of the canonical project root that
 * extracts per-file evidence: language, declared symbols, import specifiers,
 * and test-file classification. Deliberately NOT a code graph: no entity
 * resolution, no caller/callee relationships, no chunks. Phase 5 needs the
 * smallest representation that supports ambient behavior (likely files,
 * imports/imported-by, source/test counterparts, lexical discovery).
 *
 * Bounds (mirroring the reference implementations' caps):
 * - directory pruning: node_modules, .git, dist, build, coverage, .venv, caches;
 * - max files, max bytes per file, max lines parsed;
 * - symlinks are skipped;
 * - parsing is regex-based per language family — cheap and failure-tolerant
 *   (a parse error only degrades that one file's evidence, never the scan).
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export const REPOSITORY_SCAN_MAX_FILES = 6000;
export const REPOSITORY_SCAN_MAX_BYTES = 512 * 1024;
export const REPOSITORY_SCAN_MAX_SYMBOLS_PER_FILE = 500;

const PRUNED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	".next",
	".turbo",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".idea",
	".vscode",
]);

const TEST_PATH_PATTERN = /\.(test|spec)\.[^/]+$/;
const TEST_DIR_PATTERN = /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/;

export function isTestPath(relativePath: string): boolean {
	return TEST_PATH_PATTERN.test(relativePath) || TEST_DIR_PATTERN.test(relativePath);
}

export type RepositoryLanguage =
	| "typescript"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "c"
	| "cpp"
	| "csharp"
	| "java"
	| "ruby"
	| "php"
	| "markdown"
	| "generic";

const EXTENSION_LANGUAGES = {
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".cs": "csharp",
	".java": "java",
	".rb": "ruby",
	".php": "php",
	".md": "markdown",
	".mdx": "markdown",
} satisfies Record<string, RepositoryLanguage>;

export function detectLanguage(path: string): RepositoryLanguage {
	const ext = extname(path).toLowerCase();
	const language = EXTENSION_LANGUAGES[ext as keyof typeof EXTENSION_LANGUAGES];
	return language ?? "generic";
}

export interface RepositorySymbol {
	name: string;
	kind: string;
	line: number;
}

export interface RepositoryFileIndex {
	/** Repo-relative path, forward slashes. */
	path: string;
	language: RepositoryLanguage;
	sizeBytes: number;
	mtimeMs: number;
	isTest: boolean;
	symbols: RepositorySymbol[];
	/** Raw import specifiers as written (relative and bare). */
	imports: string[];
	/** True when the file was skipped by a cap (symbols/imports missing). */
	truncated: boolean;
}

export interface RepositoryScanResult {
	root: string;
	files: RepositoryFileIndex[];
	skippedDirectories: number;
	skippedBinary: number;
	skippedTooLarge: number;
	truncated: number;
	durationMs: number;
	completedAt: number;
}

const IMPORT_PATTERNS: Readonly<Record<string, RegExp>> = {
	typescript:
		/(?:import\s+[^'"]*?from\s*|import\s*\(\s*|export\s+[^'"]*?from\s*)['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g,
	javascript:
		/(?:import\s+[^'"]*?from\s*|import\s*\(\s*|export\s+[^'"]*?from\s*)['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g,
	python: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm,
	go: /^\s*import\s+["`]([^"`]+)["`]|^\s*["`]([^"`]+)["`]$/gm,
	rust: /^\s*use\s+([^;{}]+);/gm,
	c: /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm,
	cpp: /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm,
};

const SYMBOL_PATTERNS: Readonly<Partial<Record<RepositoryLanguage, RegExp[]>>> = {
	typescript: [
		/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
		/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
		/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,
		/^(?:export\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)/gm,
		/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
		/^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
	],
	javascript: [
		/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
		/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
		/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
	],
	python: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm],
	go: [
		/^func\s+([A-Za-z_]\w*)/gm,
		/^func\s+\([^)]*\)\s+([A-Za-z_]\w*)/gm,
		/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm,
	],
	rust: [/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, /^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm],
	c: [/^[A-Za-z_][\w\s*]*\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm, /^(?:typedef\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)/gm],
	cpp: [
		/^[A-Za-z_][\w:<>\s*&]*\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/gm,
		/^(?:class|struct)\s+([A-Za-z_]\w*)/gm,
	],
	csharp: [
		/^(?:public|private|protected|internal|static|async|virtual|override|sealed|partial|\s)*\s+(?:class|interface|struct|record)\s+([A-Za-z_]\w*)/gm,
		/^\s*(?:public|private|protected|internal|static|async|virtual|override)?\s*[\w<>[\],\s]+\s([A-Za-z_]\w*)\s*\(/gm,
	],
	java: [
		/^\s*(?:public|private|protected|static|final|abstract|synchronized|\s)*\s*(?:class|interface|enum)\s+([A-Za-z_]\w*)/gm,
		/^\s*(?:public|private|protected|static|final|synchronized|\s)*[\w<>[\],\s]+\s([A-Za-z_]\w*)\s*\(/gm,
	],
	ruby: [/^\s*(?:def\s+self\.|def\s+)([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_:]\w*)/gm],
	php: [
		/^\s*(?:public|private|protected|static)?\s*function\s+([A-Za-z_]\w*)/gm,
		/^\s*(?:abstract\s+)?class\s+([A-Za-z_]\w*)/gm,
	],
};

/** Bounded directory walk; yields files without reading them. */
export async function walkRepositoryFiles(
	root: string,
	options?: { maxFiles?: number },
): Promise<{ files: string[]; skippedDirectories: number }> {
	const maxFiles = options?.maxFiles ?? REPOSITORY_SCAN_MAX_FILES;
	const files: string[] = [];
	let skippedDirectories = 0;

	async function visit(dir: string, relative: string): Promise<void> {
		if (files.length >= maxFiles) {
			return;
		}
		let entries: Dirent[];
		try {
			entries = (await readdir(join(root, dir), { withFileTypes: true })) as Dirent[];
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) {
				return;
			}
			if (entry.isSymbolicLink()) {
				continue;
			}
			const name = entry.name.toString();
			const childRelative = relative === "" ? name : `${relative}/${name}`;
			if (entry.isDirectory()) {
				if (PRUNED_DIRECTORIES.has(name) || name.startsWith(".")) {
					skippedDirectories += 1;
					continue;
				}
				await visit(childRelative, childRelative);
			} else if (entry.isFile()) {
				files.push(childRelative);
			}
		}
	}

	await visit("", "");
	return { files, skippedDirectories };
}

/** Should this directory be pruned from a repository walk? */
export function shouldPruneRepositoryDirectory(name: string): boolean {
	return PRUNED_DIRECTORIES.has(name) || name.startsWith(".");
}

/** Extract import specifiers from file content for a supported language. */
export function extractImports(content: string, language: RepositoryLanguage): string[] {
	const pattern = IMPORT_PATTERNS[language];
	if (!pattern) {
		return [];
	}
	const imports: string[] = [];
	for (const match of content.matchAll(pattern)) {
		const specifier = match[1] ?? match[2];
		if (specifier && specifier !== "." && specifier !== "..") {
			imports.push(specifier);
		}
	}
	return imports;
}

/** Extract top-level symbol declarations for a supported language. */
export function extractSymbols(content: string, language: RepositoryLanguage): RepositorySymbol[] {
	const patterns = SYMBOL_PATTERNS[language];
	if (!patterns) {
		return [];
	}
	const symbols: RepositorySymbol[] = [];
	const seen = new Set<string>();
	let line = 0;
	for (const lineText of content.split("\n")) {
		line += 1;
		if (lineText.length > 2000) {
			continue;
		}
		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			const match = pattern.exec(lineText);
			if (!match) {
				continue;
			}
			const name = match[1];
			if (!name || seen.has(name)) {
				continue;
			}
			seen.add(name);
			symbols.push({ name, kind: kindOfPattern(pattern), line });
			if (symbols.length >= REPOSITORY_SCAN_MAX_SYMBOLS_PER_FILE) {
				return symbols;
			}
		}
	}
	return symbols;
}

function kindOfPattern(pattern: RegExp): string {
	if (/function|def|fn|func|^\s*(public|private|protected|internal|static)/.test(pattern.source)) {
		return "function";
	}
	if (/class|interface|struct|enum|trait|record/.test(pattern.source)) {
		return "type";
	}
	return "value";
}

/** Scan a single file into a `RepositoryFileIndex` (bounded). */
export async function scanRepositoryFile(root: string, relativePath: string): Promise<RepositoryFileIndex | undefined> {
	const absolutePath = join(root, relativePath);
	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(absolutePath);
	} catch {
		return undefined;
	}
	if (!fileStat.isFile() || fileStat.size > REPOSITORY_SCAN_MAX_BYTES) {
		return undefined;
	}
	let content = "";
	let truncated = false;
	try {
		content = await readFile(absolutePath, "utf8");
	} catch {
		return undefined;
	}
	if (content.length > REPOSITORY_SCAN_MAX_BYTES) {
		content = content.slice(0, REPOSITORY_SCAN_MAX_BYTES);
		truncated = true;
	}
	const language = detectLanguage(relativePath);
	return {
		path: relativePath,
		language,
		sizeBytes: fileStat.size,
		mtimeMs: fileStat.mtimeMs,
		isTest: isTestPath(relativePath),
		symbols: extractSymbols(content, language),
		imports: extractImports(content, language),
		truncated,
	};
}

/** Scan a repository root (bounded walk + per-file evidence). */
export async function scanRepository(root: string, options?: { maxFiles?: number }): Promise<RepositoryScanResult> {
	const startedAt = Date.now();
	const { files, skippedDirectories } = await walkRepositoryFiles(root, options);
	const indexed: RepositoryFileIndex[] = [];
	let skippedBinary = 0;
	let skippedTooLarge = 0;
	for (const relativePath of files) {
		if (BINARY_PATH_PATTERN.test(relativePath)) {
			skippedBinary += 1;
			continue;
		}
		const index = await scanRepositoryFile(root, relativePath);
		if (!index) {
			skippedTooLarge += 1;
			continue;
		}
		indexed.push(index);
	}
	indexed.sort((a, b) => a.path.localeCompare(b.path));
	return {
		root,
		files: indexed,
		skippedDirectories,
		skippedBinary,
		skippedTooLarge,
		truncated: indexed.filter((f) => f.truncated).length,
		durationMs: Date.now() - startedAt,
		completedAt: Date.now(),
	};
}

const BINARY_PATH_PATTERN =
	/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|exe|dll|so|dylib|class|jar|db|sqlite|node|bin|dat)$/i;
