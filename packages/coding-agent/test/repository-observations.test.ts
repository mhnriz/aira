import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MAX_REPOSITORY_OBSERVATIONS, RepositoryObservationStore } from "../src/core/repository-observations.ts";
import { createReadToolDefinition, type ReadOperations, type ReadToolInput } from "../src/core/tools/read.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "aira-observations-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

interface Counter {
	reads: number;
}

function testOperations(counter: Counter): ReadOperations {
	return {
		access: async (path) => {
			await access(path, constants.R_OK);
		},
		readFile: async (path) => {
			counter.reads++;
			return readFile(path);
		},
		detectImageMimeType: async () => null,
		stat: async (path) => {
			const stats = await stat(path);
			return { isFile: stats.isFile(), mtimeMs: stats.mtimeMs, size: stats.size };
		},
	};
}

function makeTool(store?: RepositoryObservationStore, counter: Counter = { reads: 0 }) {
	const tool = createReadToolDefinition(dir, { observations: store, operations: testOperations(counter) });
	return { tool, counter };
}

async function read(tool: ReturnType<typeof makeTool>["tool"], args: ReadToolInput) {
	return tool.execute("call", args, undefined, undefined, { cwd: dir } as ExtensionContext);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

function event(partial: Record<string, unknown>): AgentEvent {
	return partial as unknown as AgentEvent;
}

function editEnd(toolCallId: string, path: string, isError = false): AgentEvent[] {
	return [
		event({ type: "tool_execution_start", toolCallId, toolName: "edit", args: { path } }),
		event({ type: "tool_execution_end", toolCallId, toolName: "edit", result: {}, isError }),
	];
}

describe("repository observations: store", () => {
	it("first observation is recorded, second matching lookup hits", async () => {
		const store = new RepositoryObservationStore();
		const file = join(dir, "a.ts");
		await writeFile(file, "one\ntwo\nthree\n");
		const key = store.observationKey("a.ts", dir);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(
			key,
			{ path: file, startLine: 0, lines: ["one", "two", "three", ""], totalFileLines: 4, reachesEof: true },
			fingerprint,
		);
		const hit = store.lookup(key, fingerprint, {});
		expect(hit?.lines).toEqual(["one", "two", "three", ""]);
		expect(store.stats().observationHits).toBe(1);
	});

	it("a coverage miss does not discard the observation or count as an invalidation", async () => {
		const store = new RepositoryObservationStore();
		const file = join(dir, "a.ts");
		const key = store.observationKey("a.ts", dir);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(
			key,
			{ path: file, startLine: 3, lines: ["d", "e"], totalFileLines: 10, reachesEof: false },
			fingerprint,
		);
		expect(store.lookup(key, fingerprint, { offset: 1 })).toBeUndefined();
		expect(store.lookup(key, fingerprint, { offset: 4, limit: 1 })).toBeDefined();
		const stats = store.stats();
		expect(stats.observationInvalidations).toBe(0);
		expect(stats.observationHits).toBe(1);
	});

	it("evicts least recently used observations past the bound", () => {
		const store = new RepositoryObservationStore(2);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 1 };
		for (const name of ["a", "b"]) {
			store.record(
				store.observationKey(name, dir),
				{ path: join(dir, name), startLine: 0, lines: ["x"], totalFileLines: 1, reachesEof: true },
				fingerprint,
			);
		}
		// Touch "a" so "b" becomes the least recently used entry.
		expect(store.lookup(store.observationKey("a", dir), fingerprint, {})).toBeDefined();
		store.record(
			store.observationKey("c", dir),
			{ path: join(dir, "c"), startLine: 0, lines: ["x"], totalFileLines: 1, reachesEof: true },
			fingerprint,
		);
		expect(store.size()).toBe(2);
		expect(store.lookup(store.observationKey("a", dir), fingerprint, {})).toBeDefined();
	});

	it("uses the default bound", () => {
		expect(MAX_REPOSITORY_OBSERVATIONS).toBe(128);
	});

	it("normalizes equivalent path spellings to one observation", () => {
		const store = new RepositoryObservationStore();
		expect(store.observationKey("./src/a.ts", dir)).toBe(store.observationKey("src/a.ts", dir));
		expect(store.observationKey("src/./a.ts", dir)).toBe(store.observationKey("src/a.ts", dir));
	});

	it("detects external drift through the fingerprint and counts it as an invalidation", async () => {
		const store = new RepositoryObservationStore();
		const file = join(dir, "a.ts");
		const key = store.observationKey("a.ts", dir);
		const before = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(key, { path: file, startLine: 0, lines: ["one"], totalFileLines: 1, reachesEof: true }, before);
		expect(store.lookup(key, { isFile: true, mtimeMs: 2, size: 3 }, {})).toBeUndefined();
		expect(store.stats().observationInvalidations).toBe(1);
		expect(store.size()).toBe(0);
	});

	it("invalidates one path on a successful path-scoped mutation", () => {
		const store = new RepositoryObservationStore();
		const file = join(dir, "a.ts");
		const key = store.observationKey("a.ts", dir);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(key, { path: file, startLine: 0, lines: ["one"], totalFileLines: 1, reachesEof: true }, fingerprint);
		for (const step of editEnd("call-1", "a.ts")) {
			store.onAgentEvent(step, dir);
		}
		// Fingerprint is unchanged, so only the mutation sequence can explain the miss.
		expect(store.lookup(key, fingerprint, {})).toBeUndefined();
		expect(store.stats().observationInvalidations).toBe(1);
	});

	it("keeps unrelated observations on a path-scoped mutation", () => {
		const store = new RepositoryObservationStore();
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		const keyA = store.observationKey("a.ts", dir);
		store.record(
			keyA,
			{ path: join(dir, "a.ts"), startLine: 0, lines: ["one"], totalFileLines: 1, reachesEof: true },
			fingerprint,
		);
		for (const step of editEnd("call-1", "b.ts")) {
			store.onAgentEvent(step, dir);
		}
		expect(store.lookup(keyA, fingerprint, {})?.lines).toEqual(["one"]);
	});

	it("does not invalidate on a failed mutation", () => {
		const store = new RepositoryObservationStore();
		const key = store.observationKey("a.ts", dir);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(
			key,
			{ path: join(dir, "a.ts"), startLine: 0, lines: ["one"], totalFileLines: 1, reachesEof: true },
			fingerprint,
		);
		for (const step of editEnd("call-1", "a.ts", true)) {
			store.onAgentEvent(step, dir);
		}
		expect(store.lookup(key, fingerprint, {})?.lines).toEqual(["one"]);
		expect(store.stats().observationInvalidations).toBe(0);
	});

	it("keeps observations across read-only and diagnostic tool results", () => {
		const store = new RepositoryObservationStore();
		const key = store.observationKey("a.ts", dir);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(
			key,
			{ path: join(dir, "a.ts"), startLine: 0, lines: ["one"], totalFileLines: 1, reachesEof: true },
			fingerprint,
		);
		for (const toolName of ["grep", "find", "ls", "read", "tasks", "process_status"]) {
			store.onAgentEvent(event({ type: "tool_execution_end", toolCallId: toolName, toolName, result: {} }), dir);
		}
		expect(store.lookup(key, fingerprint, {})?.lines).toEqual(["one"]);
	});

	it("fails stale on an operation that cannot be proven path-local", () => {
		const store = new RepositoryObservationStore();
		const key = store.observationKey("a.ts", dir);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(
			key,
			{ path: join(dir, "a.ts"), startLine: 0, lines: ["one"], totalFileLines: 1, reachesEof: true },
			fingerprint,
		);
		// A successful shell command may have written anything.
		store.onAgentEvent(event({ type: "tool_execution_end", toolCallId: "sh", toolName: "bash", result: {} }), dir);
		expect(store.lookup(key, fingerprint, {})).toBeUndefined();
		expect(store.stats().observationInvalidations).toBe(1);
		expect(store.size()).toBe(0);
	});

	it("fails stale on an unknown extension tool", () => {
		const store = new RepositoryObservationStore();
		const key = store.observationKey("a.ts", dir);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(
			key,
			{ path: join(dir, "a.ts"), startLine: 0, lines: ["one"], totalFileLines: 1, reachesEof: true },
			fingerprint,
		);
		store.onAgentEvent(
			event({ type: "tool_execution_end", toolCallId: "ext", toolName: "my_extension_tool", result: {} }),
			dir,
		);
		expect(store.lookup(key, fingerprint, {})).toBeUndefined();
	});

	it("fails stale when a child agent may have changed the workspace", () => {
		const store = new RepositoryObservationStore();
		const key = store.observationKey("a.ts", dir);
		const fingerprint = { isFile: true, mtimeMs: 1, size: 3 };
		store.record(
			key,
			{ path: join(dir, "a.ts"), startLine: 0, lines: ["one"], totalFileLines: 1, reachesEof: true },
			fingerprint,
		);
		store.onAgentEvent(
			event({ type: "tool_execution_end", toolCallId: "children", toolName: "agents_delegate", result: {} }),
			dir,
		);
		expect(store.lookup(key, fingerprint, {})).toBeUndefined();
	});
});

describe("repository observations: read tool", () => {
	it("misses the first read and hits the unchanged second read without a physical read", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n");

		const first = await read(tool, { path: "a.ts" });
		expect(counter.reads).toBe(1);
		expect(store.stats().observationHits).toBe(0);
		expect(store.size()).toBe(1);

		const second = await read(tool, { path: "a.ts" });
		expect(counter.reads).toBe(1);
		expect(store.stats().observationHits).toBe(1);
		expect(textOf(second)).toBe(textOf(first));
	});

	it("returns a result byte-for-byte equivalent to a fresh physical read", async () => {
		const store = new RepositoryObservationStore();
		const cached = makeTool(store);
		const fresh = makeTool();
		await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\ndelta\n");
		await read(cached.tool, { path: "a.ts" });
		const reused = await read(cached.tool, { path: "a.ts" });
		const physical = await read(fresh.tool, { path: "a.ts" });
		expect(textOf(reused)).toBe(textOf(physical));
		expect(reused.details).toEqual(physical.details);
		expect(cached.counter.reads).toBe(1);
	});

	it("serves a contained range from a full-file observation", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "l1\nl2\nl3\nl4\nl5\nl6\n");
		await read(tool, { path: "a.ts" });
		const ranged = await read(tool, { path: "a.ts", offset: 3, limit: 2 });
		expect(counter.reads).toBe(1);
		expect(store.stats().observationHits).toBe(1);
		const fresh = await read(makeTool().tool, { path: "a.ts", offset: 3, limit: 2 });
		expect(textOf(ranged)).toBe(textOf(fresh));
	});

	it("does not serve a full-file request from a range observation", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "l1\nl2\nl3\nl4\nl5\nl6\n");
		await read(tool, { path: "a.ts", offset: 3, limit: 2 });
		const full = await read(tool, { path: "a.ts" });
		expect(counter.reads).toBe(2);
		expect(store.stats().observationHits).toBe(0);
		expect(textOf(full)).toContain("l1");
	});

	it("does not serve an uncovered range", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "l1\nl2\nl3\nl4\nl5\nl6\n");
		await read(tool, { path: "a.ts", offset: 1, limit: 2 });
		const other = await read(tool, { path: "a.ts", offset: 4, limit: 2 });
		expect(counter.reads).toBe(2);
		const fresh = await read(makeTool().tool, { path: "a.ts", offset: 4, limit: 2 });
		expect(textOf(other)).toBe(textOf(fresh));
	});

	it("conservatively rereads a repeated unbounded read of a truncated file", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		const body = Array.from({ length: 2100 }, (_, index) => `line-${index}`).join("\n");
		await writeFile(join(dir, "big.ts"), body);
		const first = await read(tool, { path: "big.ts" });
		const second = await read(tool, { path: "big.ts" });
		// The first read hit the truncation cap, so it cannot prove it saw EOF.
		expect(counter.reads).toBe(2);
		expect(store.stats().observationHits).toBe(0);
		expect(textOf(second)).toBe(textOf(first));
	});

	it("serves a bounded range inside a truncated observation", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		const body = Array.from({ length: 2100 }, (_, index) => `line-${index}`).join("\n");
		await writeFile(join(dir, "big.ts"), body);
		await read(tool, { path: "big.ts" });
		const inside = await read(tool, { path: "big.ts", offset: 1500, limit: 100 });
		const fresh = await read(makeTool().tool, { path: "big.ts", offset: 1500, limit: 100 });
		expect(counter.reads).toBe(1);
		expect(store.stats().observationHits).toBe(1);
		expect(textOf(inside)).toBe(textOf(fresh));
		const beyond = await read(tool, { path: "big.ts", offset: 2050, limit: 10 });
		expect(counter.reads).toBe(2);
		expect(textOf(beyond)).toContain("line-2049");
	});

	it("invalidates a same-file observation after a successful edit event", async () => {
		const store = new RepositoryObservationStore();
		const { tool } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "before\n");
		await read(tool, { path: "a.ts" });
		for (const step of editEnd("edit-1", "a.ts")) {
			store.onAgentEvent(step, dir);
		}
		await writeFile(join(dir, "a.ts"), "after\n");
		const reread = await read(tool, { path: "a.ts" });
		expect(textOf(reread)).toBe("after\n");
		expect(store.stats().observationInvalidations).toBe(1);
	});

	it("invalidates a same-file observation after a recovered edit event", async () => {
		const store = new RepositoryObservationStore();
		const { tool } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "before\n");
		await read(tool, { path: "a.ts" });
		// Step 6 recovery still reports a successful `edit` execution.
		store.onAgentEvent(
			event({ type: "tool_execution_start", toolCallId: "edit-2", toolName: "edit", args: { path: "a.ts" } }),
			dir,
		);
		store.onAgentEvent(
			event({
				type: "tool_execution_end",
				toolCallId: "edit-2",
				toolName: "edit",
				result: { details: { recovered: true } },
			}),
			dir,
		);
		await writeFile(join(dir, "a.ts"), "recovered\n");
		const reread = await read(tool, { path: "a.ts" });
		expect(textOf(reread)).toBe("recovered\n");
	});

	it("invalidates a same-file observation after a successful write event", async () => {
		const store = new RepositoryObservationStore();
		const { tool } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "before\n");
		await read(tool, { path: "a.ts" });
		store.onAgentEvent(
			event({ type: "tool_execution_start", toolCallId: "w", toolName: "write", args: { path: "a.ts" } }),
			dir,
		);
		store.onAgentEvent(event({ type: "tool_execution_end", toolCallId: "w", toolName: "write", result: {} }), dir);
		await writeFile(join(dir, "a.ts"), "written\n");
		expect(textOf(await read(tool, { path: "a.ts" }))).toBe("written\n");
	});

	it("keeps an observation when a different file is edited", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "alpha\n");
		await writeFile(join(dir, "b.ts"), "beta\n");
		await read(tool, { path: "a.ts" });
		for (const step of editEnd("edit-b", "b.ts")) {
			store.onAgentEvent(step, dir);
		}
		const reread = await read(tool, { path: "a.ts" });
		expect(counter.reads).toBe(1);
		expect(store.stats().observationHits).toBe(1);
		expect(textOf(reread)).toBe("alpha\n");
	});

	it("keeps an observation when an edit fails", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "alpha\n");
		await read(tool, { path: "a.ts" });
		for (const step of editEnd("edit-fail", "a.ts", true)) {
			store.onAgentEvent(step, dir);
		}
		expect(textOf(await read(tool, { path: "a.ts" }))).toBe("alpha\n");
		expect(counter.reads).toBe(1);
	});

	it("rereads after an external filesystem change", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		const file = join(dir, "a.ts");
		await writeFile(file, "old\n");
		await read(tool, { path: "a.ts" });
		await writeFile(file, "new\n");
		const reread = await read(tool, { path: "a.ts" });
		expect(counter.reads).toBe(2);
		expect(textOf(reread)).toBe("new\n");
		expect(store.stats().observationInvalidations).toBe(1);
	});

	it("rereads after an external change that preserved the byte size", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		const file = join(dir, "a.ts");
		await writeFile(file, "aaa\n");
		await read(tool, { path: "a.ts" });
		await writeFile(file, "bbb\n");
		await utimes(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
		const reread = await read(tool, { path: "a.ts" });
		expect(counter.reads).toBe(2);
		expect(textOf(reread)).toBe("bbb\n");
	});

	it("never returns stale content for a deleted file", async () => {
		const store = new RepositoryObservationStore();
		const { tool } = makeTool(store);
		const file = join(dir, "a.ts");
		await writeFile(file, "here\n");
		await read(tool, { path: "a.ts" });
		await rm(file);
		await expect(read(tool, { path: "a.ts" })).rejects.toThrow();
	});

	it("does not cache failed reads", async () => {
		const store = new RepositoryObservationStore();
		const { tool } = makeTool(store);
		await expect(read(tool, { path: "missing.ts" })).rejects.toThrow();
		expect(store.size()).toBe(0);
		expect(store.stats().observationHits).toBe(0);
	});

	it("does not reuse an observation across different path spellings", async () => {
		const store = new RepositoryObservationStore();
		const { tool, counter } = makeTool(store);
		await writeFile(join(dir, "a.ts"), "alpha\n");
		await read(tool, { path: "a.ts" });
		const dotted = await read(tool, { path: "./a.ts" });
		expect(counter.reads).toBe(1);
		expect(store.size()).toBe(1);
		expect(textOf(dotted)).toBe("alpha\n");
	});
});
