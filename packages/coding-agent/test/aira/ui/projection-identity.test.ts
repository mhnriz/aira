import { describe, expect, it } from "vitest";
import { workbenchProjectionEquals } from "../../../src/aira/ui/projection-identity.ts";
import type { WorkbenchPanel, WorkbenchProjection } from "../../../src/aira/ui/types.ts";

function panel(overrides: Partial<WorkbenchPanel> = {}): WorkbenchPanel {
	return {
		id: "goal",
		title: "Goal",
		priority: 1,
		rows: [{ value: "objective" }],
		...overrides,
	};
}

function projection(overrides: Partial<WorkbenchProjection> = {}): WorkbenchProjection {
	return {
		layout: "wide",
		sidebarVisible: true,
		panels: [panel()],
		footer: [],
		finding: undefined,
		summary: "ok",
		...overrides,
	};
}

describe("workbenchProjectionEquals", () => {
	it("treats distinct but structurally identical projections as equal", () => {
		expect(workbenchProjectionEquals(projection(), projection())).toBe(true);
	});

	it("treats the same reference as equal", () => {
		const value = projection();
		expect(workbenchProjectionEquals(value, value)).toBe(true);
	});

	it("detects row value changes", () => {
		const a = projection();
		const b = projection({ panels: [panel({ rows: [{ value: "changed" }] })] });
		expect(workbenchProjectionEquals(a, b)).toBe(false);
	});

	it("detects row trailing/detail/key changes", () => {
		expect(
			workbenchProjectionEquals(
				projection(),
				projection({ panels: [panel({ rows: [{ value: "objective", trailing: "3s" }] })] }),
			),
		).toBe(false);
		expect(
			workbenchProjectionEquals(
				projection(),
				projection({ panels: [panel({ rows: [{ value: "objective", detail: "more" }] })] }),
			),
		).toBe(false);
		expect(
			workbenchProjectionEquals(
				projection(),
				projection({ panels: [panel({ rows: [{ value: "objective", key: "k" }] })] }),
			),
		).toBe(false);
	});

	it("detects panel hint/cap/progress changes", () => {
		expect(workbenchProjectionEquals(projection(), projection({ panels: [panel({ hint: "waiting 3s" })] }))).toBe(
			false,
		);
		expect(workbenchProjectionEquals(projection(), projection({ panels: [panel({ mediumCap: 3 })] }))).toBe(false);
		expect(
			workbenchProjectionEquals(
				projection(),
				projection({ panels: [panel({ progress: { value: 0.5, role: "green" } })] }),
			),
		).toBe(false);
	});

	it("detects layout and visibility changes", () => {
		expect(workbenchProjectionEquals(projection(), projection({ layout: "medium" }))).toBe(false);
		expect(workbenchProjectionEquals(projection(), projection({ sidebarVisible: false }))).toBe(false);
	});

	it("ignores footer, finding, and summary (rendered by other surfaces)", () => {
		const a = projection();
		const b = projection({
			footer: [
				{ id: "context", text: "ctx 42%", dropRank: 3 },
				{ id: "usage", text: "12k tokens", dropRank: 4 },
			],
			finding: { severity: "warning", source: "lsp", label: "one issue", priority: 2 },
			summary: "yellow",
		});
		expect(workbenchProjectionEquals(a, b)).toBe(true);
	});

	it("handles undefined projections", () => {
		expect(workbenchProjectionEquals(undefined, undefined)).toBe(true);
		expect(workbenchProjectionEquals(projection(), undefined)).toBe(false);
		expect(workbenchProjectionEquals(undefined, projection())).toBe(false);
	});

	it("detects panel count and order changes", () => {
		const twoPanels = projection({ panels: [panel(), panel({ id: "tasks", title: "Tasks" })] });
		expect(workbenchProjectionEquals(projection(), twoPanels)).toBe(false);
		const reordered = projection({ panels: [panel({ id: "tasks", title: "Tasks" })] });
		expect(workbenchProjectionEquals(projection(), reordered)).toBe(false);
	});
});
