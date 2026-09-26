import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { findingPanel } from "../../../src/aira/ui/panels.ts";
import type { WorkbenchFinding, WorkbenchProjection } from "../../../src/aira/ui/types.ts";
import { setTheme } from "../../../src/modes/interactive/theme/theme.ts";
import {
	fitPanelCount,
	renderWorkbenchProjection,
} from "../../../src/modes/interactive/workbench/workbench-component.ts";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function plain(text: string): string {
	return text.replace(ANSI, "");
}

function projection(): WorkbenchProjection {
	return {
		layout: "wide",
		sidebarVisible: true,
		panels: [
			{
				id: "control",
				title: "Control",
				priority: 3,
				hint: "policy",
				rows: [
					{ label: "Permission", value: "normal", role: "purple" },
					{ label: "Rules", value: "6 persistent · 0 session", role: "muted" },
					{
						label: "Finding",
						value: "controller.ts:184",
						role: "red",
						detail: "Cannot find name 'handle' in an intentionally long diagnostic message",
					},
				],
			},
		],
		footer: [],
		finding: undefined,
		summary: "BUILD",
	};
}

describe("Workbench terminal renderer", () => {
	beforeAll(() => {
		expect(setTheme("aira-zhr").success).toBe(true);
	});

	it("renders a persistent pane edge and separated label/value columns", () => {
		const lines = renderWorkbenchProjection(projection(), 38, 20);
		expect(plain(lines[0] ?? "")).toContain("│  SESSION CONTEXT");
		expect(plain(lines[1] ?? "")).toContain("│  CANONICAL STATE · TOKEN-FREE");
		expect(plain(lines[2] ?? "")).toMatch(/^├ {2}─+/);
		const permission = lines.find((line) => plain(line).includes("Permission"));
		expect(plain(permission ?? "")).toMatch(/Permission\s+normal/);
	});

	it("bounds every emitted line and preserves diagnostic indentation", () => {
		const lines = renderWorkbenchProjection(projection(), 30, 20);
		expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
		expect(lines.map(plain).some((line) => line.includes("Cannot find"))).toBe(true);
	});

	it("counts detail rows when dropping panels for a short viewport", () => {
		const panel = projection().panels[0]!;
		expect(fitPanelCount([panel], 6, true)).toBe(0);
		expect(fitPanelCount([panel], 8, true)).toBe(1);
	});
});

describe("Current Finding panel layout", () => {
	const finding = (path: string): WorkbenchFinding => ({
		severity: "info",
		source: "lsp",
		code: "CS8019",
		label: "Unnecessary using directive.",
		detail: `${path}:12 · fresh`,
		priority: 2,
	});

	function findingProjection(value: WorkbenchFinding): WorkbenchProjection {
		return {
			layout: "wide",
			sidebarVisible: true,
			panels: [findingPanel(value)!],
			footer: [],
			finding: value,
			summary: "BUILD",
		};
	}

	const longWindowsPath = "D:\\IROPO_basler_C#\\iropo\\src\\Really\\Long\\Nested\\Path\\File.cs";

	for (const width of [30, 42, 60, 120]) {
		it(`keeps heading, location and message structurally present at width ${width}`, () => {
			const lines = renderWorkbenchProjection(findingProjection(finding(longWindowsPath)), width, 20).map(plain);
			expect(lines.some((line) => line.includes("CURRENT FINDING"))).toBe(true);
			expect(lines.some((line) => line.includes("D:\\IROPO_basler_C#"))).toBe(true);
			expect(lines.some((line) => line.includes("CS8019 · Unnecessary"))).toBe(true);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		});
	}

	it("renders a short path verbatim beneath the heading", () => {
		const lines = renderWorkbenchProjection(findingProjection(finding("src/x.ts")), 60, 20).map(plain);
		expect(lines.some((line) => line.includes("CURRENT FINDING"))).toBe(true);
		expect(lines.some((line) => line.includes("src/x.ts:12 · fresh"))).toBe(true);
	});

	it("renders a path containing '#' verbatim", () => {
		const lines = renderWorkbenchProjection(findingProjection(finding("D:\\repo#2\\src\\file.cs")), 60, 20).map(
			plain,
		);
		expect(lines.some((line) => line.includes("D:\\repo#2\\src\\file.cs:12 · fresh"))).toBe(true);
		expect(lines.some((line) => line.includes("CURRENT FINDING"))).toBe(true);
	});

	it("respects wide-character display width for a unicode path", () => {
		const unicodePath = "D:\\项目\\源码\\verylongfilename_without_breaks.cs";
		for (const width of [30, 42, 60]) {
			const lines = renderWorkbenchProjection(findingProjection(finding(unicodePath)), width, 20).map(plain);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.some((line) => line.includes("CURRENT FINDING"))).toBe(true);
			expect(lines.some((line) => line.includes("CS8019 · Unnecessary"))).toBe(true);
		}
	});

	it("orders heading, location and message when a long path would previously hide the heading", () => {
		// Regression: the location used to be the panel hint on the title line, so a
		// wide path could consume the whole row and truncate CURRENT FINDING away.
		const lines = renderWorkbenchProjection(findingProjection(finding(longWindowsPath)), 42, 20).map(plain);
		const headingIndex = lines.findIndex((line) => line.includes("CURRENT FINDING"));
		const locationIndex = lines.findIndex((line) => line.includes("D:\\IROPO_basler_C#"));
		const messageIndex = lines.findIndex((line) => line.includes("CS8019 · Unnecessary"));
		expect(headingIndex).toBeGreaterThanOrEqual(0);
		expect(locationIndex).toBeGreaterThan(headingIndex);
		expect(messageIndex).toBeGreaterThan(locationIndex);
	});
});
