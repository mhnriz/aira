/**
 * Phase 9 — child tool-set construction: capability-derived tools, the PLAN
 * collapse, and isolation rules (no browser / orchestration / unknown tools;
 * process tools bind to the root execution manager).
 */
import { describe, expect, it } from "vitest";
import type { AiraIntelligenceHandle } from "../../../src/aira/intelligence/coordinator.ts";
import { buildAiraChildToolSet } from "../../../src/aira/orchestration/tools.ts";

/** Minimal execution-manager stub (the tools only call into it when used). */
function stubExecutionManager() {
	const manager = {
		sessionCwd: "/proj/demo",
		start: async () => ({
			status: "exited" as const,
			ok: true,
			command: "true",
			cwd: "/proj/demo",
			startedAt: 0,
			durationMs: 1,
			exitCode: 0,
			stdout: { text: "", truncated: false },
			stderr: { text: "", truncated: false },
		}),
		get: () => undefined,
		list: () => [],
		logs: () => undefined,
		terminate: async () => undefined,
		subscribe: () => () => undefined,
		dispose: async () => undefined,
	};
	return manager as never;
}

function stubIntelligence(): AiraIntelligenceHandle {
	return {
		activate: async () => undefined,
		providePromptContext: () => undefined,
		applyAgentEvent: () => undefined,
		waitUntilSettled: async () => undefined,
		verificationChanges: async () => undefined,
		workingSet: async () => undefined,
		relevantSymbols: () => [],
		searchSymbols: () => ({ status: "ready", query: "", results: [], truncated: false }),
		moduleReport: async () => ({
			status: "not-found",
			path: "",
			symbols: [],
			imports: [],
			importedBy: [],
			counterparts: [],
			truncated: false,
		}),
		semanticNavigation: async () => ({ status: "not-found", operation: "symbols", truncated: false }),
		subscribe: () => () => undefined,
		dispose: async () => undefined,
	};
}

describe("Aira child tool sets (Phase 9)", () => {
	it("read-only roles get exactly read + diagnostic tools", () => {
		for (const role of ["explore", "research", "review"] as const) {
			const set = buildAiraChildToolSet({ cwd: "/proj/demo", role, mode: "build" });
			expect(set.tools.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
			expect(set.mutating).toBe(false);
		}
	});

	it("eligible children share the root intelligence tool owner", () => {
		const set = buildAiraChildToolSet({
			cwd: "/proj/demo",
			role: "explore",
			mode: "build",
			intelligence: stubIntelligence(),
		});
		expect(set.tools.map((tool) => tool.name).sort()).toEqual([
			"aira_module_report",
			"aira_semantic_navigation",
			"aira_symbol_search",
			"find",
			"grep",
			"ls",
			"read",
		]);
	});

	it("implement role gets write/edit in BUILD (plus the read-only base)", () => {
		const set = buildAiraChildToolSet({ cwd: "/proj/demo", role: "implement", mode: "build" });
		const names = set.tools.map((tool) => tool.name).sort();
		expect(names).toContain("edit");
		expect(names).toContain("write");
		expect(names).toContain("read");
		expect(set.mutating).toBe(true);
	});

	it("test role gets managed-execution tools bound to the root manager", () => {
		const set = buildAiraChildToolSet({
			cwd: "/proj/demo",
			role: "test",
			mode: "build",
			executionManager: stubExecutionManager() as never,
		});
		const names = set.tools.map((tool) => tool.name);
		expect(names).toContain("process_start");
		expect(names).toContain("process_stop");
		expect(names).toContain("process_status");
		expect(set.mutating).toBe(true);
	});

	it("PLAN collapses every role to the read-only classes (no mutation path)", () => {
		for (const role of ["explore", "review", "test", "implement"] as const) {
			const set = buildAiraChildToolSet({
				cwd: "/proj/demo",
				role,
				mode: "plan",
				executionManager: stubExecutionManager() as never,
			});
			expect(set.tools.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
			expect(set.mutating).toBe(false);
			expect(set.capabilities).toEqual(["read-only", "diagnostic"]);
		}
	});

	it("never grants browser, orchestration, or unknown tools to children", () => {
		for (const role of ["explore", "implement"] as const) {
			const set = buildAiraChildToolSet({
				cwd: "/proj/demo",
				role,
				mode: "build",
				executionManager: stubExecutionManager() as never,
			});
			const names = set.tools.map((tool) => tool.name);
			expect(names.some((name) => name.startsWith("browser_"))).toBe(false);
			expect(names.some((name) => name.startsWith("agents_"))).toBe(false);
			expect(names.some((name) => name.startsWith("unknown"))).toBe(false);
		}
	});
});
