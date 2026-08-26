import { describe, expect, it } from "vitest";
import {
	type AiraFinding,
	AiraFindingsStore,
	airaFindingId,
	freshnessFromMtime,
	isAiraFindingBlocking,
	summarizeFindingsForPaths,
} from "../../../src/aira/intelligence/findings.ts";

function finding(overrides: Partial<AiraFinding> = {}): Omit<AiraFinding, "id" | "at" | "turn" | "freshness"> {
	return {
		path: "/proj/src/a.ts",
		source: "lsp",
		providerId: "typescript",
		severity: "error",
		message: "boom",
		...overrides,
	};
}

describe("Aira findings freshness kernel", () => {
	it("marks a file modified after collection as stale", () => {
		const referenceMs = 1_000_000;
		expect(freshnessFromMtime({ mtimeMs: referenceMs + 60, referenceMs })).toBe("stale");
	});

	it("keeps a file untouched since collection fresh (with drift tolerance)", () => {
		const referenceMs = 1_000_000;
		expect(freshnessFromMtime({ mtimeMs: referenceMs + 30, referenceMs })).toBe("fresh");
		expect(freshnessFromMtime({ mtimeMs: referenceMs - 10, referenceMs })).toBe("fresh");
	});

	it("reports indeterminate without mtime evidence rather than guessing fresh", () => {
		expect(freshnessFromMtime({ mtimeMs: undefined, referenceMs: 1_000 })).toBe("indeterminate");
	});

	it("respects an explicit tolerance override", () => {
		expect(freshnessFromMtime({ mtimeMs: 1010, referenceMs: 1000, toleranceMs: 100 })).toBe("fresh");
	});
});

describe("Aira finding identity", () => {
	it("is stable across identical collections and distinct across messages", () => {
		const base = { path: "/p/x.ts", source: "lsp", providerId: "typescript", message: "msg" } as const;
		expect(airaFindingId({ ...base, line: 3 })).toBe(airaFindingId({ ...base, line: 3 }));
		expect(airaFindingId({ ...base, line: 3 })).not.toBe(airaFindingId({ ...base, line: 4 }));
		expect(airaFindingId({ ...base })).not.toBe(airaFindingId({ ...base, message: "other" }));
	});

	it("classifies error findings as blocking and warnings as advisory", () => {
		expect(isAiraFindingBlocking({ ...finding(), severity: "error" } as AiraFinding)).toBe(true);
		expect(isAiraFindingBlocking({ ...finding(), severity: "warning" } as AiraFinding)).toBe(false);
	});
});

describe("Aira findings store", () => {
	it("replaces a path's findings atomically on re-collection", () => {
		const store = new AiraFindingsStore();
		store.replaceForPath("/p/a.ts", [finding({ message: "old" }), finding({ message: "old2", severity: "warning" })]);
		expect(store.forPath("/p/a.ts").length).toBe(2);
		expect(store.counts()).toMatchObject({ errors: 1, warnings: 1, paths: 1 });

		store.replaceForPath("/p/a.ts", [finding({ message: "new" })]);
		const current = store.forPath("/p/a.ts");
		expect(current.length).toBe(1);
		expect(current[0]!.message).toBe("new");
		expect(store.counts()).toMatchObject({ errors: 1, paths: 1 });
	});

	it("tags findings with collection time and turn, and filters by turn", () => {
		const store = new AiraFindingsStore();
		store.setTurn(2);
		store.replaceForPath("/p/a.ts", [finding()], 5000);
		const stored = store.forPath("/p/a.ts");
		expect(stored[0]?.at).toBe(5000);
		expect(stored[0]?.turn).toBe(2);
		expect(store.forTurn(2).length).toBe(1);
		expect(store.forTurn(1).length).toBe(0);
	});

	it("clears a path on edit and reports no findings for cleared paths", () => {
		const store = new AiraFindingsStore();
		store.replaceForPath("/p/a.ts", [finding()]);
		store.clearPath("/p/a.ts");
		expect(store.forPath("/p/a.ts")).toEqual([]);
		expect(store.size).toBe(0);
		// Clearing an unknown path is a no-op.
		store.clearPath("/p/unknown.ts");
		expect(store.size).toBe(0);
	});

	it("refreshes freshness against current mtimes (stale when file changed)", () => {
		const store = new AiraFindingsStore();
		const collectedAt = 100_000;
		store.replaceForPath("/p/a.ts", [finding()], collectedAt);
		expect(store.forPath("/p/a.ts", collectedAt - 1)[0]?.freshness).toBe("fresh");
		expect(store.forPath("/p/a.ts", collectedAt + 100)[0]?.freshness).toBe("stale");

		const mtimes = new Map([["/p/a.ts", collectedAt + 100]]);
		store.replaceForPath("/p/b.ts", [finding({ path: "/p/b.ts", message: "w" })], collectedAt);
		mtimes.set("/p/b.ts", collectedAt - 1);
		expect(store.refreshAll((p) => mtimes.get(p))).toMatchObject({ total: 2, stale: 1 });
	});

	it("renders a bounded per-path summary that excludes stale findings", () => {
		const store = new AiraFindingsStore();
		const collectedAt = 1000;
		store.replaceForPath(
			"/p/a.ts",
			[finding({ message: "first" }), finding({ message: "second", severity: "warning" })],
			collectedAt,
		);
		store.replaceForPath("/p/b.ts", [finding({ path: "/p/b.ts", message: "stale msg" })], collectedAt);

		// Mark b's findings stale because the file moved after collection.
		store.refreshAll((p) => (p === "/p/b.ts" ? collectedAt + 100 : collectedAt - 1));

		const summary = summarizeFindingsForPaths(store, ["/p/a.ts", "/p/b.ts"], { maxPerPath: 1 });
		expect(summary).toContain("/p/a.ts");
		expect(summary).toContain("E:first");
		expect(summary).toContain("stale");
		expect(summary).not.toContain("stale msg");
	});

	it("evicts oldest paths beyond the cap", () => {
		const store = new AiraFindingsStore({ maxFindings: 3 });
		store.replaceForPath("/p/a.ts", [finding()]);
		store.replaceForPath("/p/b.ts", [finding({ path: "/p/b.ts" })]);
		store.replaceForPath("/p/c.ts", [finding({ path: "/p/c.ts" })]);
		store.replaceForPath("/p/d.ts", [finding({ path: "/p/d.ts" })]);
		expect(store.size).toBe(3);
		expect(store.forPath("/p/a.ts")).toEqual([]);
		expect(store.paths).toEqual(["/p/b.ts", "/p/c.ts", "/p/d.ts"]);
	});
});
