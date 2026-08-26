import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadRepositoryCache,
	repositoryCacheKey,
	saveRepositoryCache,
} from "../../../src/aira/intelligence/providers/repository/cache.ts";
import { RepositoryProvider } from "../../../src/aira/intelligence/providers/repository/index.ts";
import {
	RepositoryRelationships,
	sourceTestCounterparts,
	tokenize,
} from "../../../src/aira/intelligence/providers/repository/relationships.ts";
import {
	detectLanguage,
	extractImports,
	extractSymbols,
	isTestPath,
	scanRepository,
	scanRepositoryFile,
	shouldPruneRepositoryDirectory,
} from "../../../src/aira/intelligence/providers/repository/scanner.ts";

let dirs: string[] = [];

function makeRoot(name: string): string {
	const root = join(tmpdir(), `aira-repo-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	dirs.push(root);
	return root;
}

function write(root: string, rel: string, content: string): void {
	const target = join(root, rel);
	mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
	writeFileSync(target, content);
}

afterEach(() => {
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	dirs = [];
});

beforeEach(() => {
	dirs = [];
});

describe("repository scanner", () => {
	it("classifies languages and test paths", () => {
		expect(detectLanguage("src/a.ts")).toBe("typescript");
		expect(detectLanguage("x.py")).toBe("python");
		expect(detectLanguage("y.cpp")).toBe("cpp");
		expect(detectLanguage("data.json")).toBe("generic");
		expect(isTestPath("src/a.test.ts")).toBe(true);
		expect(isTestPath("src/a.spec.tsx")).toBe(true);
		expect(isTestPath("tests/test_x.py")).toBe(true);
		expect(isTestPath("src/a.ts")).toBe(false);
		expect(shouldPruneRepositoryDirectory("node_modules")).toBe(true);
		expect(shouldPruneRepositoryDirectory(".git")).toBe(true);
		expect(shouldPruneRepositoryDirectory("src")).toBe(false);
	});

	it("extracts import specifiers per language", () => {
		expect(
			extractImports(`import { a } from "./b";\nimport c from "pkg";\nconst d = require("../e");`, "typescript"),
		).toEqual(["./b", "pkg", "../e"]);
		expect(extractImports("from x import y\nimport z\nimport a.b", "python")).toEqual(["x", "z", "a.b"]);
		expect(extractImports("use std::collections::HashMap;\nuse crate::foo;", "rust")).toEqual([
			"std::collections::HashMap",
			"crate::foo",
		]);
		expect(extractImports('import "fmt"\nimport "os"', "go")).toEqual(["fmt", "os"]);
		expect(extractImports('#include <vector>\n#include "local.h"', "cpp")).toEqual(["vector", "local.h"]);
	});

	it("extracts declared symbols with kinds and lines", () => {
		const symbols = extractSymbols(
			"export function greet() {}\nclass Widget {}\ninterface Shape {}\nconst x = 1;",
			"typescript",
		);
		expect(symbols.map((s) => [s.name, s.kind, s.line])).toEqual([
			["greet", "function", 1],
			["Widget", "type", 2],
			["Shape", "type", 3],
			["x", "value", 4],
		]);
		expect(extractSymbols("def run():\n    pass\nclass Calc:", "python")).toEqual([
			{ name: "run", kind: "function", line: 1 },
			{ name: "Calc", kind: "type", line: 3 },
		]);
	});

	it("scans a fixture tree with pruning and caps", async () => {
		const root = makeRoot("scan");
		write(root, "src/a.ts", "export function alpha() {}\nimport { b } from './b';\n");
		write(root, "src/b.ts", "export const beta = 1;\n");
		write(root, "src/a.test.ts", "import { it } from 'vitest';\nit('works', () => {});");
		write(root, "node_modules/pkg/index.js", "const skip = 1;");
		write(root, ".git/HEAD", "ref: refs/heads/main");
		write(root, "data.bin", "not code");
		const result = await scanRepository(root);
		const paths = result.files.map((f) => f.path).sort();
		expect(paths).toEqual(["src/a.test.ts", "src/a.ts", "src/b.ts"]);
		expect(result.skippedDirectories).toBeGreaterThanOrEqual(2);
		expect(result.files.find((f) => f.path === "src/a.ts")?.symbols[0]?.name).toBe("alpha");
		expect(result.files.find((f) => f.path === "src/a.test.ts")?.isTest).toBe(true);
	});

	it("returns undefined for missing or oversized files", async () => {
		const root = makeRoot("caps");
		expect(await scanRepositoryFile(root, "missing.ts")).toBeUndefined();
		write(root, "big.ts", "x".repeat(600 * 1024));
		expect(await scanRepositoryFile(root, "big.ts")).toBeUndefined();
	});
});

describe("repository relationships", () => {
	it("resolves relative imports and builds imported-by edges", async () => {
		const root = makeRoot("edges");
		write(root, "src/a.ts", "import { b } from './b';\n");
		write(root, "src/b.ts", "export const b = 1;");
		const files = (await scanRepository(root)).files;
		const rels = new RepositoryRelationships();
		rels.rebuild(files);
		expect(rels.importTargets("src/a.ts")).toEqual(["src/b.ts"]);
		expect(rels.importedByPaths("src/b.ts")).toEqual(["src/a.ts"]);
		// Bare specifiers are not resolved into the index.
		expect(rels.importTargets("src/b.ts")).toEqual([]);
	});

	it("finds existing source/test counterparts via path heuristics", async () => {
		const root = makeRoot("counterparts");
		write(root, "src/state.ts", "export function resolve() {}");
		write(root, "src/state.test.ts", "import { it } from 'vitest';");
		write(root, "lib/util.py", "def helper(): pass");
		write(root, "tests/test_util.py", "from lib.util import helper");
		const rels = new RepositoryRelationships();
		rels.rebuild((await scanRepository(root)).files);
		expect(rels.counterparts("src/state.ts")).toEqual(["src/state.test.ts"]);
		expect(rels.counterparts("tests/test_util.py")).toEqual(["lib/util.py"]);
		expect(rels.counterparts("src/state.test.ts")).toEqual(["src/state.ts"]);
	});

	it("discovers likely files by identifier tokens", async () => {
		const root = makeRoot("discover");
		write(root, "src/tray.ts", "export function stabilizeTray() {}\nexport function detectionState() {}");
		write(root, "src/other.ts", "export function unrelatedHelper() {}");
		const rels = new RepositoryRelationships();
		rels.rebuild((await scanRepository(root)).files);
		const hits = rels.discover("detection state switches back", { limit: 5 });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.path).toBe("src/tray.ts");
		expect(hits[0]?.symbols).toContain("detectionState");
	});

	it("tokenizes identifiers into searchable pieces", () => {
		const tokens = tokenize("getUserByID");
		expect(tokens.has("get")).toBe(true);
		expect(tokens.has("user")).toBe(true);
		expect(tokens.has("getuserbyid")).toBe(true);
		expect(tokenize("stabilize_tray").has("tray")).toBe(true);
		expect(tokenize("inspect-symbols").has("symbols")).toBe(true);
	});

	it("computes counterpart candidates without duplicates", () => {
		expect(sourceTestCounterparts("src/x.ts")).toEqual([
			"src/x.test.ts",
			"src/x.spec.ts",
			"test/x.test.ts",
			"tests/x.test.ts",
		]);
		expect(sourceTestCounterparts("src/x.test.ts")).toEqual(["src/x.ts"]);
		expect(sourceTestCounterparts("tests/test_util.py")).toContain("lib/util.py");
	});
});

describe("repository provider", () => {
	it("scans, discovers, and reports status", async () => {
		const root = makeRoot("provider");
		write(root, "src/main.ts", "export function entry() {}\nimport { dep } from './dep';\n");
		write(root, "src/dep.ts", "export const dep = 1;");
		write(root, "src/main.test.ts", "import { it } from 'vitest';");
		const provider = new RepositoryProvider(root);
		await provider.activate();
		await provider.settled();
		expect(provider.statusInfo().status).toBe("ready");
		expect(provider.statusInfo().filesIndexed).toBe(3);
		expect(provider.discover("entry", { limit: 3 })[0]?.path).toBe("src/main.ts");
		expect(provider.importedBy(join(root, "src/dep.ts"))).toEqual([join(root, "src/main.ts")]);
		expect(provider.counterparts(join(root, "src/main.ts"))).toEqual([join(root, "src/main.test.ts")]);
	});

	it("reindexes a file incrementally after an edit", async () => {
		const root = makeRoot("reindex");
		write(root, "src/a.ts", "export function before() {}");
		const provider = new RepositoryProvider(root);
		await provider.activate();
		await provider.settled();
		expect(provider.fileFor(join(root, "src/a.ts"))?.symbols[0]?.name).toBe("before");
		write(root, "src/a.ts", "export function after() {}");
		await provider.reindexFile(join(root, "src/a.ts"));
		expect(provider.fileFor(join(root, "src/a.ts"))?.symbols[0]?.name).toBe("after");
		expect(provider.discover("before").length).toBe(0);
		expect(provider.discover("after").length).toBeGreaterThan(0);
	});

	it("persists to and reloads from the Aira home cache", async () => {
		const root = makeRoot("cache");
		write(root, "src/a.ts", "export function cached() {}");
		const cacheDir = join(tmpdir(), `aira-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		dirs.push(cacheDir);
		const provider = new RepositoryProvider(root, { cacheDir });
		await provider.activate();
		await provider.settled();
		expect(provider.statusInfo().cacheLoaded).toBe(false);
		const cached = await loadRepositoryCache(cacheDir, root);
		expect(cached?.files.length).toBe(1);
		expect(repositoryCacheKey(root)).toBe(repositoryCacheKey(root));
		// Reload from cache: second provider binds persisted evidence without a fresh scan flag.
		const provider2 = new RepositoryProvider(root, { cacheDir });
		await provider2.activate();
		await provider2.settled();
		expect(provider2.statusInfo().cacheLoaded).toBe(true);
		expect(provider2.statusInfo().filesIndexed).toBe(1);
	});

	it("degrades on an unreadable root instead of failing", async () => {
		const provider = new RepositoryProvider(join(tmpdir(), "does-not-exist-aira"));
		await provider.activate();
		await provider.settled();
		const info = provider.statusInfo();
		expect(info.status === "ready" || info.status === "degraded").toBe(true);
		expect(provider.discover("anything")).toEqual([]);
	});

	it("tracks git changed files and session edits", async () => {
		const root = makeRoot("changes");
		write(root, "src/a.ts", "export function a() {}");
		const provider = new RepositoryProvider(root);
		provider.noteEdit(join(root, "src/a.ts"));
		provider.noteEdit(join(root, "src/new.ts"));
		const changed = provider.changedAbsolutePaths();
		expect(changed).toContain(join(root, "src/a.ts"));
		expect(changed).toContain(join(root, "src/new.ts"));
		await provider.refreshChanges();
		expect(provider.statusInfo().changes.available).toBe(false); // not a git repo → unavailable
	});

	it("reports git changes inside a real git repo", async () => {
		const root = makeRoot("git");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
		execFileSync("git", ["config", "user.name", "t"], { cwd: root });
		write(root, "src/a.ts", "export function a() {}");
		execFileSync("git", ["add", "-A"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
		write(root, "src/a.ts", "export function a() {}\n// changed");
		write(root, "src/b.ts", "export function b() {}");
		const provider = new RepositoryProvider(root);
		await provider.refreshChanges();
		const info = provider.statusInfo();
		expect(info.changes.available).toBe(true);
		expect(info.changes.count).toBe(2);
		const changed = provider.changedAbsolutePaths();
		expect(changed).toContain(join(root, "src/a.ts"));
		expect(changed).toContain(join(root, "src/b.ts"));
		// working tree is dirty again for cleanup; remove fixture root contents
	});

	it("round-trips the cache file (save then load)", async () => {
		const root = makeRoot("cache2");
		write(root, "src/a.ts", "export function cached() {}");
		const cacheDir = join(tmpdir(), `aira-cache2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		dirs.push(cacheDir);
		const files = (await scanRepository(root)).files;
		await saveRepositoryCache(cacheDir, root, { version: 1, root, scannedAt: Date.now(), files });
		const loaded = await loadRepositoryCache(cacheDir, root);
		expect(loaded?.files.length).toBe(1);
		expect(loaded?.files[0]?.path).toBe("src/a.ts");
	});
});
