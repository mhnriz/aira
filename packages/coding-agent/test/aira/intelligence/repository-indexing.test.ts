import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryProvider } from "../../../src/aira/intelligence/providers/repository/index.ts";
import {
	RepositoryLexicalIndex,
	RepositoryRelationships,
} from "../../../src/aira/intelligence/providers/repository/relationships.ts";

let dirs: string[] = [];

function makeRoot(name: string): string {
	const root = join(tmpdir(), `aira-repo-idx-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	dirs.push(root);
	return root;
}

function makeCacheDir(name: string): string {
	const dir = join(tmpdir(), `aira-repo-idx-cache-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	dirs.push(dir);
	return dir;
}

function write(root: string, rel: string, content: string): void {
	const target = join(root, rel);
	mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
	writeFileSync(target, content);
}

/** Seed `count` TypeScript files, each importing the next one by relative path. */
function seedRepo(root: string, count: number): void {
	for (let i = 0; i < count; i++) {
		const dep = i + 1 < count ? `import { value${i + 1} } from "./file${i + 1}";\n` : "";
		write(root, `src/file${i}.ts`, `${dep}export function symbol${i}() {}\nexport const value${i} = ${i};\n`);
	}
}

async function warmProvider(root: string, cacheDir: string): Promise<RepositoryProvider> {
	const provision = new RepositoryProvider(root, { cacheDir });
	await provision.activate();
	await provision.settled();
	const provider = new RepositoryProvider(root, { cacheDir });
	await provider.activate();
	await provider.settled();
	expect(provider.statusInfo().cacheLoaded).toBe(true);
	return provider;
}

/**
 * Spy on a method by name through an erased prototype view. TypeScript hides
 * `private` members from `keyof`, but the runtime prototype still carries
 * them; this keeps instrumentation in the test instead of production code.
 */
function spyPrototype(target: object, name: string) {
	return vi.spyOn(target as Record<string, (...args: never[]) => unknown>, name);
}

beforeEach(() => {
	dirs = [];
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	dirs = [];
});

describe("cold repository indexing", () => {
	it("indexes each file exactly once instead of once per file pair", async () => {
		const root = makeRoot("cold-once");
		seedRepo(root, 40);
		const indexSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "index");
		const removeSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "remove");
		const rebuildSpy = vi.spyOn(RepositoryRelationships.prototype, "rebuild");
		const applySpy = vi.spyOn(RepositoryRelationships.prototype, "applyChanges");
		const globalSpy = spyPrototype(RepositoryRelationships.prototype, "rebuildImportedBy");

		const provider = new RepositoryProvider(root);
		await provider.activate();
		await provider.settled();

		expect(provider.statusInfo().filesIndexed).toBe(40);
		// O(F): one lexical index call per file. The old path produced F(F+1)/2.
		expect(indexSpy.mock.calls.length).toBe(40);
		// No per-file token removal is needed when the index starts empty.
		expect(removeSpy.mock.calls.length).toBe(0);
		expect(rebuildSpy.mock.calls.length).toBe(1);
		expect(applySpy.mock.calls.length).toBe(0);
		// Global reverse-import reconstruction runs once per batch, not per file.
		expect(globalSpy.mock.calls.length).toBe(1);
	});

	it("scales lexical indexing linearly with the number of files", async () => {
		async function countIndexCalls(count: number): Promise<number> {
			const root = makeRoot(`scale-${count}`);
			seedRepo(root, count);
			const spy = vi.spyOn(RepositoryLexicalIndex.prototype, "index");
			const provider = new RepositoryProvider(root);
			await provider.activate();
			await provider.settled();
			const calls = spy.mock.calls.length;
			spy.mockRestore();
			return calls;
		}

		const small = await countIndexCalls(20);
		const large = await countIndexCalls(40);
		expect(small).toBe(20);
		expect(large).toBe(40);
		// Linear growth: doubling files at most doubles the index work.
		expect(large).toBeLessThanOrEqual(small * 2);
	});

	it("builds imports, importedBy, counterparts and lexical search on a cold scan", async () => {
		const root = makeRoot("cold-correct");
		write(root, "src/a.ts", "import { b } from './b';\nexport function alphaSymbol() {}\n");
		write(root, "src/b.ts", "export const b = 1;\n");
		write(root, "src/a.test.ts", "import { it } from 'vitest';\n");
		const provider = new RepositoryProvider(root);
		await provider.activate();
		await provider.settled();

		expect(provider.imports(join(root, "src/a.ts"))).toEqual([join(root, "src/b.ts")]);
		expect(provider.importedBy(join(root, "src/b.ts"))).toEqual([join(root, "src/a.ts")]);
		expect(provider.counterparts(join(root, "src/a.ts"))).toEqual([join(root, "src/a.test.ts")]);
		expect(provider.counterparts(join(root, "src/a.test.ts"))).toEqual([join(root, "src/a.ts")]);
		expect(provider.discover("alphaSymbol")[0]?.path).toBe("src/a.ts");
	});
});

describe("warm repository refresh", () => {
	it("performs no re-indexing when nothing changed", async () => {
		const root = makeRoot("warm-noop");
		seedRepo(root, 25);
		const provider = await warmProvider(root, makeCacheDir("warm-noop"));

		const indexSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "index");
		const removeSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "remove");
		const upsertSpy = vi.spyOn(RepositoryRelationships.prototype, "upsert");
		const globalSpy = spyPrototype(RepositoryRelationships.prototype, "rebuildImportedBy");
		await provider.refresh();

		expect(indexSpy.mock.calls.length).toBe(0);
		expect(removeSpy.mock.calls.length).toBe(0);
		expect(upsertSpy.mock.calls.length).toBe(0);
		expect(globalSpy.mock.calls.length).toBe(0);
		expect(provider.statusInfo().filesIndexed).toBe(25);
	});

	it("re-indexes only the file whose content changed", async () => {
		const root = makeRoot("warm-modify");
		write(root, "src/a.ts", "export function alphazebra() {}\n");
		write(root, "src/b.ts", "export function betayak() {}\n");
		write(root, "src/c.ts", "export function gammaxen() {}\n");
		const provider = await warmProvider(root, makeCacheDir("warm-modify"));

		write(root, "src/b.ts", "export function omegawolf() {}\nextra\n");
		const indexSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "index");
		const removeSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "remove");
		const globalSpy = spyPrototype(RepositoryRelationships.prototype, "rebuildImportedBy");
		await provider.refresh();

		expect(indexSpy.mock.calls.length).toBe(1);
		expect(indexSpy.mock.calls[0]?.[0]).toBe("src/b.ts");
		expect(removeSpy.mock.calls.length).toBe(1);
		expect(globalSpy.mock.calls.length).toBe(1);
		expect(provider.discover("omegawolf")[0]?.path).toBe("src/b.ts");
		expect(provider.discover("betayak")).toEqual([]);
		// Unrelated files keep their evidence and remain searchable.
		expect(provider.discover("alphazebra")[0]?.path).toBe("src/a.ts");
		expect(provider.discover("gammaxen")[0]?.path).toBe("src/c.ts");
	});

	it("detects a same-size rewrite through mtime", async () => {
		const root = makeRoot("warm-mtime");
		write(root, "src/a.ts", "export function first() {}\n");
		const provider = await warmProvider(root, makeCacheDir("warm-mtime"));

		const target = join(root, "src/a.ts");
		write(root, "src/a.ts", "export function other() {}\n");
		const future = new Date(Date.now() + 2000);
		utimesSync(target, future, future);

		const indexSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "index");
		await provider.refresh();
		expect(indexSpy.mock.calls.length).toBe(1);
		expect(provider.discover("other")[0]?.path).toBe("src/a.ts");
		expect(provider.discover("first")).toEqual([]);
	});

	it("treats same-size files with an unchanged mtime as unchanged", async () => {
		const root = makeRoot("warm-same");
		write(root, "src/a.ts", "export function first() {}\n");
		const provider = await warmProvider(root, makeCacheDir("warm-same"));

		const indexSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "index");
		await provider.refresh();
		await provider.refresh();
		expect(indexSpy.mock.calls.length).toBe(0);
	});
});

describe("repository structural changes", () => {
	it("resolves a newly added import target without re-indexing unrelated files", async () => {
		const root = makeRoot("add-target");
		write(root, "src/consumer.ts", "import { lazy } from './lazy';\nexport function consume() {}\n");
		seedRepo(root, 10);
		const provider = await warmProvider(root, makeCacheDir("add-target"));
		expect(provider.imports(join(root, "src/consumer.ts"))).toEqual([]);

		write(root, "src/lazy.ts", "export const lazy = 1;\n");
		const indexSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "index");
		const removeSpy = vi.spyOn(RepositoryLexicalIndex.prototype, "remove");
		await provider.refresh();

		expect(provider.imports(join(root, "src/consumer.ts"))).toEqual([join(root, "src/lazy.ts")]);
		expect(provider.importedBy(join(root, "src/lazy.ts"))).toEqual([join(root, "src/consumer.ts")]);
		expect(provider.discover("lazy")[0]?.path).toBe("src/lazy.ts");
		// Only the new file's lexical entry is written; unchanged files are untouched.
		expect(indexSpy.mock.calls.length).toBe(1);
		expect(indexSpy.mock.calls[0]?.[0]).toBe("src/lazy.ts");
		expect(removeSpy.mock.calls.length).toBe(1);
	});

	it("drops a deleted file and its stale import edges", async () => {
		const root = makeRoot("delete");
		write(root, "src/a.ts", "import { b } from './b';\nexport function alphaKeep() {}\n");
		write(root, "src/b.ts", "export const b = 1;\nexport function betaGone() {}\n");
		const provider = await warmProvider(root, makeCacheDir("delete"));
		expect(provider.imports(join(root, "src/a.ts"))).toEqual([join(root, "src/b.ts")]);

		rmSync(join(root, "src/b.ts"));
		await provider.refresh();

		expect(provider.fileFor(join(root, "src/b.ts"))).toBeUndefined();
		expect(provider.imports(join(root, "src/a.ts"))).toEqual([]);
		expect(provider.importedBy(join(root, "src/b.ts"))).toEqual([]);
		expect(provider.discover("betaGone")).toEqual([]);
		expect(provider.discover("alphaKeep")[0]?.path).toBe("src/a.ts");
		expect(provider.statusInfo().filesIndexed).toBe(1);
	});

	it("keeps reverse import edges correct across a diamond", async () => {
		const root = makeRoot("diamond");
		write(root, "src/base.ts", "export const base = 1;\n");
		write(root, "src/left.ts", "import { base } from './base';\nexport const left = base;\n");
		write(root, "src/right.ts", "import { base } from './base';\nexport const right = base;\n");
		const provider = await warmProvider(root, makeCacheDir("diamond"));

		expect(provider.importedBy(join(root, "src/base.ts")).sort()).toEqual([
			join(root, "src/left.ts"),
			join(root, "src/right.ts"),
		]);

		rmSync(join(root, "src/left.ts"));
		await provider.refresh();
		expect(provider.importedBy(join(root, "src/base.ts"))).toEqual([join(root, "src/right.ts")]);

		write(root, "src/left.ts", "import { base } from './base';\nexport const leftAgain = base;\n");
		await provider.refresh();
		expect(provider.importedBy(join(root, "src/base.ts")).sort()).toEqual([
			join(root, "src/left.ts"),
			join(root, "src/right.ts"),
		]);
	});

	it("updates source/test counterparts as files are added and deleted", async () => {
		const root = makeRoot("counterparts");
		write(root, "src/state.ts", "export function resolveState() {}\n");
		write(root, "src/state.test.ts", "export const t = 1;\n");
		const provider = await warmProvider(root, makeCacheDir("counterparts"));
		expect(provider.counterparts(join(root, "src/state.ts"))).toEqual([join(root, "src/state.test.ts")]);

		write(root, "src/state.spec.ts", "export const s = 1;\n");
		await provider.refresh();
		expect(provider.counterparts(join(root, "src/state.ts"))).toEqual([
			join(root, "src/state.test.ts"),
			join(root, "src/state.spec.ts"),
		]);
		expect(provider.counterparts(join(root, "src/state.spec.ts"))).toEqual([join(root, "src/state.ts")]);

		rmSync(join(root, "src/state.test.ts"));
		await provider.refresh();
		expect(provider.counterparts(join(root, "src/state.ts"))).toEqual([join(root, "src/state.spec.ts")]);
		expect(provider.counterparts(join(root, "src/state.test.ts"))).toEqual([]);
	});

	it("updates import edges when a specifier changes", async () => {
		const root = makeRoot("specifier");
		write(root, "src/a.ts", "import { b } from './b';\nexport const a = b;\n");
		write(root, "src/b.ts", "export const b = 1;\n");
		write(root, "src/c.ts", "export const c = 2;\n");
		const provider = await warmProvider(root, makeCacheDir("specifier"));
		expect(provider.imports(join(root, "src/a.ts"))).toEqual([join(root, "src/b.ts")]);

		write(root, "src/a.ts", "import { c } from './c';\nexport const a = c;\n");
		await provider.refresh();

		expect(provider.imports(join(root, "src/a.ts"))).toEqual([join(root, "src/c.ts")]);
		expect(provider.importedBy(join(root, "src/b.ts"))).toEqual([]);
		expect(provider.importedBy(join(root, "src/c.ts"))).toEqual([join(root, "src/a.ts")]);
	});

	it("reindexFile keeps global reverse edges and lexical tokens coherent", async () => {
		const root = makeRoot("reindex-file");
		write(root, "src/a.ts", "export function beforequail() {}\n");
		write(root, "src/b.ts", "import { beforequail } from './a';\nexport const b = beforequail;\n");
		const provider = await warmProvider(root, makeCacheDir("reindex-file"));
		expect(provider.importedBy(join(root, "src/a.ts"))).toEqual([join(root, "src/b.ts")]);

		write(root, "src/a.ts", "export function aftervixen() {}\n");
		await provider.reindexFile(join(root, "src/a.ts"));

		expect(provider.discover("beforequail")).toEqual([]);
		expect(provider.discover("aftervixen")[0]?.path).toBe("src/a.ts");
		expect(provider.importedBy(join(root, "src/a.ts"))).toEqual([join(root, "src/b.ts")]);

		await provider.reindexFile(join(root, "src/missing.ts"));
		expect(provider.discover("aftervixen")[0]?.path).toBe("src/a.ts");
	});
});

describe("incremental vs full rebuild determinism", () => {
	it("produces the same index after incremental mutations as a fresh cold build", async () => {
		const root = makeRoot("determinism");
		write(root, "src/keep.ts", "export function keepSymbol() {}\n");
		write(root, "src/change.ts", "import { keepSymbol } from './keep';\nexport const change = keepSymbol;\n");
		write(root, "src/remove.ts", "export function removeSymbol() {}\n");
		write(root, "src/stable.test.ts", "export const t = 1;\n");

		const incremental = await warmProvider(root, makeCacheDir("determinism"));
		write(root, "src/change.ts", "export const change = 1;\nexport const extra = 2;\n");
		write(root, "src/added.ts", "import { keepSymbol } from './keep';\nexport const added = keepSymbol;\n");
		rmSync(join(root, "src/remove.ts"));
		await incremental.refresh();

		const fresh = new RepositoryProvider(root);
		await fresh.activate();
		await fresh.settled();

		const paths = ["src/keep.ts", "src/change.ts", "src/added.ts", "src/stable.test.ts", "src/remove.ts"];
		const snapshot = (provider: RepositoryProvider) => ({
			indexed: provider.statusInfo().filesIndexed,
			query: provider.discover("keepSymbol", { limit: 20 }),
			perFile: paths.map((rel) => [
				rel,
				provider.imports(join(root, rel)),
				provider.importedBy(join(root, rel)),
				provider.counterparts(join(root, rel)),
			]),
		});
		expect(snapshot(incremental)).toEqual(snapshot(fresh));

		// Rebuilding deterministically twice yields identical output.
		const again = new RepositoryProvider(root);
		await again.activate();
		await again.settled();
		expect(snapshot(again)).toEqual(snapshot(fresh));
	});

	it("refreshes correctly after cache save/load with one changed file", async () => {
		const root = makeRoot("cache-refresh");
		write(root, "src/a.ts", "export function alphaOne() {}\n");
		write(root, "src/b.ts", "import { alphaOne } from './a';\nexport const b = alphaOne;\n");
		const cacheDir = makeCacheDir("cache-refresh");
		const provider = await warmProvider(root, cacheDir);

		write(root, "src/a.ts", "export function alphaTwo() {}\n");
		await provider.refresh();
		expect(provider.discover("alphaTwo")[0]?.path).toBe("src/a.ts");
		expect(provider.importedBy(join(root, "src/b.ts"))).toEqual([]);
		expect(provider.imports(join(root, "src/b.ts"))).toEqual([join(root, "src/a.ts")]);

		// A second provider loading the refreshed cache agrees.
		const reloaded = new RepositoryProvider(root, { cacheDir });
		await reloaded.activate();
		await reloaded.settled();
		expect(reloaded.statusInfo().cacheLoaded).toBe(true);
		expect(reloaded.discover("alphaTwo")[0]?.path).toBe("src/a.ts");
		expect(reloaded.imports(join(root, "src/b.ts"))).toEqual([join(root, "src/a.ts")]);
	});
});
