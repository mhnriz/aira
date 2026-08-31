import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkbenchProjection } from "../../../src/aira/ui/types.ts";
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
		expect(plain(lines[0] ?? "")).toContain("│  AIRA WORKBENCH");
		expect(plain(lines[1] ?? "")).toMatch(/^├ {2}─+/);
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
