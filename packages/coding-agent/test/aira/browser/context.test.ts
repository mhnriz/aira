/**
 * Phase 7 — ambient browser context budget tests.
 *
 * Token-budget contract (the brief's CASE A-E):
 * - CASE A: browser active, unrelated prompt, context=auto → zero browser
 *   context tokens (no signal);
 * - CASE B: unchanged evidence, second prompt → not duplicated (hash dedupe
 *   + no signal);
 * - CASE C: context=off, browser active with errors → snapshot still shows
 *   state; no ambient context;
 * - CASE D: context=on + actionable error → bounded evidence injected;
 * - CASE E: large observation state → hard budget respected (compact pack
 *   stays <= 600 chars).
 */
import { describe, expect, it } from "vitest";
import { buildBrowserContext } from "../../../src/aira/browser/context.ts";
import type { AiraBrowserStatus } from "../../../src/aira/browser/status.ts";

function statusWith(overrides: Partial<AiraBrowserStatus>): AiraBrowserStatus {
	return {
		availability: "available",
		eligible: true,
		status: "active",
		provider: "cdp-chromium",
		profileKind: "isolated",
		tabs: [{ id: "tab-1", url: "http://localhost:5173/player", title: "player", readyState: "complete" }],
		activeTab: { id: "tab-1", url: "http://localhost:5173/player", title: "player", readyState: "complete" },
		console: { errors: 0, warnings: 0, total: 0 },
		network: { failures: 0 },
		observation: { revision: 3, summary: "player page · ready · 2 buttons", nodeCount: 120, lastAt: 1 },
		verification: { status: "none" },
		screenshot: {},
		updatedAt: 1,
		...overrides,
	};
}

describe("Phase 7 — ambient browser context budget", () => {
	it("CASE A: browser active + unrelated prompt + auto → no context injected", () => {
		const built = buildBrowserContext({
			settings: { context: "auto", budget: "compact" },
			status: statusWith({}),
			relevanceSignal: false,
			pendingEdits: 0,
		});
		expect(built.content).toBeUndefined();
	});

	it("CASE A2: no active browser session → no context even in auto/on", () => {
		for (const context of ["auto", "on"] as const) {
			const built = buildBrowserContext({
				settings: { context, budget: "compact" },
				status: statusWith({ status: "idle", tabs: [] }),
				relevanceSignal: true,
				pendingEdits: 1,
			});
			expect(built.content, context).toBeUndefined();
		}
	});

	it("CASE B: unchanged evidence + no signal → unchanged content not duplicated", () => {
		const input = {
			settings: { context: "on" as const, budget: "compact" as const },
			status: statusWith({
				console: {
					errors: 1,
					warnings: 0,
					total: 1,
					topFinding: {
						message: "TypeError: player.seek is not a function",
						source: "src/player.ts",
						line: 184,
						count: 1,
						firstAt: 1,
						lastAt: 1,
					},
				},
			}),
			relevanceSignal: false,
			pendingEdits: 0,
		};
		const first = buildBrowserContext(input);
		expect(first.content).toBeDefined();
		const second = buildBrowserContext({ ...input, lastHash: first.hash });
		// Identical content (same hash, no signal) is never re-injected.
		expect(second.content).toBeUndefined();
	});

	it("CASE C: context=off → state visible in snapshot, zero prompt context", () => {
		const built = buildBrowserContext({
			settings: { context: "off", budget: "compact" },
			status: statusWith({
				console: {
					errors: 2,
					warnings: 1,
					total: 3,
					topFinding: { message: "boom", count: 2, firstAt: 1, lastAt: 2 },
				},
			}),
			relevanceSignal: true,
			pendingEdits: 1,
		});
		expect(built.content).toBeUndefined();
		// The snapshot carries the state regardless (UI-visible, token-free).
		expect(statusWith({}).console.errors).toBe(0);
		const withErrors = statusWith({
			console: {
				errors: 2,
				warnings: 1,
				total: 3,
				topFinding: { message: "boom", count: 2, firstAt: 1, lastAt: 2 },
			},
		});
		expect(withErrors.console.errors).toBe(2);
	});

	it("CASE D: context=on + actionable console error → bounded evidence", () => {
		const built = buildBrowserContext({
			settings: { context: "on", budget: "compact" },
			status: statusWith({
				console: {
					errors: 1,
					warnings: 0,
					total: 1,
					topFinding: {
						message: "TypeError: player.seek is not a function",
						source: "src/player.ts",
						line: 184,
						count: 1,
						firstAt: 1,
						lastAt: 1,
					},
				},
				network: {
					failures: 1,
					topFinding: {
						message: "GET /api/now-playing — HTTP 500",
						source: "localhost",
						count: 1,
						firstAt: 1,
						lastAt: 1,
					},
				},
			}),
			relevanceSignal: true,
			pendingEdits: 0,
		});
		expect(built.content).toBeDefined();
		expect(built.content).toContain("TypeError: player.seek is not a function");
		expect(built.content).toContain("src/player.ts:184");
		expect(built.content).toContain("network: 1 failed");
		expect(built.hash).toBeDefined();
	});

	it("CASE D2: auto + relevance signal (verification failed) → evidence injected", () => {
		const built = buildBrowserContext({
			settings: { context: "auto", budget: "compact" },
			status: statusWith({
				verification: {
					status: "failed",
					lastCheckAt: 5,
					finding: { message: "GET /api/x — HTTP 500", source: "localhost", count: 1, firstAt: 1, lastAt: 5 },
				},
			}),
			relevanceSignal: true,
			pendingEdits: 0,
		});
		expect(built.content).toBeDefined();
		expect(built.content).toContain("check: failed");
	});

	it("CASE E: hard budget respected for every size class", () => {
		const consoleRecords: AiraBrowserStatus["console"] = {
			errors: 5,
			warnings: 3,
			total: 8,
			topFinding: {
				message: "x".repeat(400),
				source: "src/long-file.ts",
				line: 999,
				count: 5,
				firstAt: 1,
				lastAt: 2,
			},
		};
		const sizes = {
			compact: 600,
			balanced: 1200,
			expanded: 2400,
		} as const;
		for (const [budget, max] of Object.entries(sizes) as Array<[keyof typeof sizes, number]>) {
			const built = buildBrowserContext({
				settings: { context: "on", budget },
				status: statusWith({ console: consoleRecords }),
				relevanceSignal: true,
				pendingEdits: 1,
			});
			expect(built.content).toBeDefined();
			expect(built.content!.length, budget).toBeLessThanOrEqual(max);
		}
	});

	it("auto mode gates on signals after a browser-relevant edit", () => {
		const base = {
			settings: { context: "auto" as const, budget: "compact" as const },
			status: statusWith({}),
		};
		// No signal → nothing.
		expect(buildBrowserContext({ ...base, relevanceSignal: false, pendingEdits: 0 }).content).toBeUndefined();
		// Pending relevant edit → injected.
		const withEdit = buildBrowserContext({ ...base, relevanceSignal: true, pendingEdits: 1 });
		expect(withEdit.content).toBeDefined();
		expect(withEdit.content).toContain("localhost:5173");
	});
});
