/**
 * Fresh vs stale diagnostics presentation (Workbench Intelligence panel).
 *
 * The published intelligence status separates current totals (fresh findings)
 * from stale ones: stale findings never inflate the primary error/warning
 * totals, are reported in a subordinate Stale row, and stale details render
 * muted. The findings store itself is untouched by presentation.
 */
import { describe, expect, it } from "vitest";
import type { AiraIntelligenceStatus, AiraIntelligenceTopFinding } from "../../../src/aira/intelligence/status.ts";
import { initialAiraIntelligenceStatus } from "../../../src/aira/intelligence/status.ts";
import { type AiraSessionState, acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { intelligencePanel } from "../../../src/aira/ui/panels.ts";
import type { WorkbenchRow } from "../../../src/aira/ui/types.ts";

function sessionWithFindings(findings: AiraIntelligenceStatus["findings"]): {
	state: AiraSessionState;
	dispose: () => void;
} {
	const state = acquireAiraSessionState("diag-freshness", "startup");
	state.intelligence = {
		...initialAiraIntelligenceStatus(),
		active: true,
		liveCode: { status: "ready", servers: [], spawnCount: 0, crashCount: 0 },
		findings,
	};
	return { state, dispose: () => disposeAiraSessionState("diag-freshness", state) };
}

function findings(
	setup: { freshErrors?: number; freshWarnings?: number; staleCount?: number; staleErrors?: number } = {},
): AiraIntelligenceStatus["findings"] {
	const { freshErrors = 0, freshWarnings = 0, staleCount = 0, staleErrors = 0 } = setup;
	const fresh: AiraIntelligenceTopFinding[] = [];
	for (let i = 0; i < freshErrors; i++) {
		fresh.push({
			severity: "error",
			code: `E${i}`,
			message: `fresh error ${i}`,
			path: `src/a${i}.ts`,
			freshness: "fresh",
		});
	}
	for (let i = 0; i < freshWarnings; i++) {
		fresh.push({
			severity: "warning",
			code: `W${i}`,
			message: `fresh warning ${i}`,
			path: `src/w${i}.ts`,
			freshness: "fresh",
		});
	}
	const stale: AiraIntelligenceTopFinding[] = [];
	for (let i = 0; i < Math.min(staleCount, 8); i++) {
		stale.push({
			severity: i < staleErrors ? "error" : "warning",
			code: `S${i}`,
			message: `stale finding ${i}`,
			path: `src/s${i}.ts`,
			freshness: "stale",
		});
	}
	return {
		total: fresh.length + stale.length,
		errors: freshErrors,
		warnings: freshWarnings,
		stale: staleCount,
		top: [...fresh, ...stale].slice(0, 3),
	};
}

function rowsByLabel(rows: WorkbenchRow[]): Map<string, WorkbenchRow[]> {
	const byLabel = new Map<string, WorkbenchRow[]>();
	for (const row of rows) {
		const group = byLabel.get(row.label ?? "") ?? [];
		group.push(row);
		byLabel.set(row.label ?? "", group);
	}
	return byLabel;
}

describe("Workbench diagnostics presentation freshness", () => {
	it("shows nothing when there are no diagnostics", () => {
		const { state, dispose } = sessionWithFindings({ total: 0, errors: 0, warnings: 0, stale: 0, top: [] });
		const rows = intelligencePanel(state)?.rows ?? [];
		expect(rows.some((row) => row.label === "Diagnostics")).toBe(false);
		expect(rows.some((row) => row.label === "Stale")).toBe(false);
		dispose();
	});

	it("shows fresh errors/warnings only as the primary totals", () => {
		const { state, dispose } = sessionWithFindings(findings({ freshErrors: 2, freshWarnings: 1 }));
		const byLabel = rowsByLabel(intelligencePanel(state)!.rows);
		expect(byLabel.get("Diagnostics")).toBeDefined();
		expect(byLabel.get("Diagnostics")![0]!.value).toBe("2E 1W");
		expect(byLabel.get("Diagnostics")![0]!.role).toBe("red");
		expect(byLabel.get("Stale")).toBeUndefined();
		dispose();
	});

	it("shows only-stale findings as stale without current totals", () => {
		const { state, dispose } = sessionWithFindings(findings({ staleCount: 4, staleErrors: 3 }));
		const byLabel = rowsByLabel(intelligencePanel(state)!.rows);
		expect(byLabel.get("Diagnostics")![0]!.value).toBe("0E 0W");
		expect(byLabel.get("Stale")![0]!.value).toBe("4");
		expect(byLabel.get("Stale")![0]!.role).toBe("muted");
		// Stale details render with a stale marker and muted (subordinate) role.
		for (const row of byLabel.get("error") ?? []) {
			expect(row.detail).toContain("stale");
			expect(row.role).toBe("muted");
		}
		dispose();
	});

	it("mixed fresh/stale: fresh totals exclude stale findings and stale count is separate", () => {
		const { state, dispose } = sessionWithFindings(
			findings({ freshErrors: 2, freshWarnings: 1, staleCount: 4, staleErrors: 3 }),
		);
		const byLabel = rowsByLabel(intelligencePanel(state)!.rows);
		expect(byLabel.get("Diagnostics")![0]!.value).toBe("2E 1W");
		expect(byLabel.get("Stale")![0]!.value).toBe("4");
		dispose();
	});

	it("large stale sets stay bounded and compact", () => {
		const { state, dispose } = sessionWithFindings(findings({ freshErrors: 1, staleCount: 40, staleErrors: 20 }));
		const rows = intelligencePanel(state)!.rows;
		const detailRows = rows.filter((row) => row.label === "error" || row.label === "warning");
		expect(detailRows.length).toBeLessThanOrEqual(3);
		expect(rowsByLabel(rows).get("Stale")![0]!.value).toBe("40");
		dispose();
	});

	it("presentation does not mutate the underlying state", () => {
		const { state, dispose } = sessionWithFindings(findings({ freshErrors: 2, staleCount: 3, staleErrors: 2 }));
		const before = JSON.stringify(state.intelligence!.findings);
		intelligencePanel(state);
		expect(JSON.stringify(state.intelligence!.findings)).toBe(before);
		dispose();
	});

	it("the store still holds stale findings; only the published status totals exclude them", () => {
		// The intelligence panel consumes the published status. The status
		// totals are fresh-only while total/stale keep the full picture; this
		// is the presentation boundary, not the findings store.
		const { state, dispose } = sessionWithFindings(findings({ freshErrors: 1, staleCount: 4, staleErrors: 4 }));
		const status = state.intelligence!.findings;
		expect(status.total).toBe(5);
		expect(status.stale).toBe(4);
		expect(status.errors).toBe(1);
		dispose();
	});
});
