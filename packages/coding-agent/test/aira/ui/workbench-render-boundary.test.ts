/**
 * Render-boundary regression: keyboard resizing must change the ACTUAL
 * rendered fullscreen pane geometry, not just the stored preference.
 *
 * Mirrors the real runtime path end to end at the layout boundary:
 *
 *   WorkbenchController.resizeBy(...) → preferred width
 *     → controller.wrapLayout(mainRoot) (reads the live preference)
 *     → renderLayoutFrame at a fixed terminal size
 *     → measure the Session Context pane's real column boundary
 *
 * The previous controller-level tests showed the preference moving but did
 * not render the layout; on 180+ column terminals the adaptive 30% rule
 * pinned the pane at 54-60 columns and masked every resize. This test locks
 * the rendered geometry at both a comfortable (165) and a very wide (200)
 * terminal, over multiple steps.
 */

import { Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderLayoutFrame } from "../../../../tui/src/layout.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { DEFAULT_WORKBENCH_WIDTH } from "../../../src/core/settings-manager.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { WorkbenchController } from "../../../src/modes/interactive/workbench/controller.ts";

beforeAll(() => {
	initTheme();
});

const stored: { enabled: boolean; showOnStartup: boolean; density: "comfortable" | "compact"; width: number } = {
	enabled: true,
	showOnStartup: true,
	density: "comfortable",
	width: DEFAULT_WORKBENCH_WIDTH,
};

interface FakeTuiTerminal {
	columns: number;
	rows: number;
}

function createController(): {
	controller: WorkbenchController;
	terminal: FakeTuiTerminal;
	layoutChanged: ReturnType<typeof vi.fn>;
} {
	const session = {
		sessionId: "render-boundary-" + Math.random().toString(36).slice(2),
		settingsManager: {
			getWorkbenchSettings: () => ({ ...stored }),
			setWorkbenchSettings: (patch: Partial<typeof stored>) => Object.assign(stored, patch),
			getFullscreenScrollbar: () => false,
		},
	} as unknown as AgentSession;
	const layoutChanged = vi.fn();
	const terminal: FakeTuiTerminal = { columns: 0, rows: 0 };
	const controller = new WorkbenchController({
		session,
		footerComponent: new Text("footer"),
		dockAnchorComponent: new Text("dock"),
		getBranch: () => undefined,
		getFooterLineCount: () => 2,
		getTranscriptFollowing: () => true,
		getFocused: () => false,
		getInspectedRunId: () => undefined,
		requestRender: () => {},
		invalidate: () => {},
		layoutChanged,
	});
	controller.bindTui({ mode: "fullscreen", terminal } as never);
	return { controller, terminal, layoutChanged };
}

type Box = { rect: { x: number; width: number }; children: Box[] };

/** The Session Context pane box: a laid-out child at x > 0 with width < 72. */
function findSidebarBox(box: Box): Box | undefined {
	if (box.rect.x > 0 && box.rect.width < 72) return box;
	for (const child of box.children) {
		const found = findSidebarBox(child);
		if (found) return found;
	}
	return undefined;
}

interface Measure {
	divider: number; // 0-based column where the Session Context pane starts
	width: number;
}

/** Render the current layout at a fixed terminal size and measure the pane. */
function measure(controller: WorkbenchController, terminal: FakeTuiTerminal, terminalWidth: number): Measure {
	// The real TUI's terminal.columns updates with the actual terminal size;
	// mirror that so wrapLayout resolves the effective width for this width.
	terminal.columns = terminalWidth;
	const root = controller.wrapLayout(new Text("conversation"));
	const frame = renderLayoutFrame(root, terminalWidth, 40, () => {});
	const sidebar = findSidebarBox(frame.root as unknown as Box);
	if (!sidebar) return { divider: -1, width: 0 };
	return { divider: sidebar.rect.x, width: sidebar.rect.width };
}

describe("Session Context render boundary (fullscreen layout)", () => {
	it("renders the default 42-column pane at 165 cols before any resize", () => {
		stored.width = DEFAULT_WORKBENCH_WIDTH;
		const { controller, terminal } = createController();
		expect(measure(controller, terminal, 165)).toEqual({ divider: 165 - 42, width: 42 });
	});

	it("Alt+] widens the rendered pane by ~4 columns per step at 165 cols", () => {
		stored.width = DEFAULT_WORKBENCH_WIDTH;
		const { controller, terminal } = createController();
		controller.resizeBy(4); // preferred 46 → pane 46 (explicit wins)
		expect(measure(controller, terminal, 165)).toEqual({ divider: 165 - 46, width: 46 });
		controller.resizeBy(4); // preferred 50
		expect(measure(controller, terminal, 165)).toEqual({ divider: 165 - 50, width: 50 });
	});

	it("Alt+[ narrows the rendered pane back at 165 cols", () => {
		stored.width = DEFAULT_WORKBENCH_WIDTH;
		const { controller, terminal } = createController();
		controller.resizeBy(4);
		controller.resizeBy(4);
		expect(measure(controller, terminal, 165).width).toBe(50);
		controller.resizeBy(-4);
		expect(measure(controller, terminal, 165).width).toBe(46);
		controller.resizeBy(-4);
		expect(measure(controller, terminal, 165).width).toBe(DEFAULT_WORKBENCH_WIDTH);
	});

	it("REGRESSION: resize moves the rendered pane on a very wide (200 col) terminal", () => {
		stored.width = DEFAULT_WORKBENCH_WIDTH;
		const { controller, terminal } = createController();
		expect(measure(controller, terminal, 200).width).toBe(DEFAULT_WORKBENCH_WIDTH);
		// The FIRST explicit resize must visibly win over the adaptive rule.
		controller.resizeBy(4);
		expect(measure(controller, terminal, 200)).toEqual({ divider: 200 - 46, width: 46 });
		controller.resizeBy(4);
		expect(measure(controller, terminal, 200).width).toBe(50);
		controller.resizeBy(-4);
		expect(measure(controller, terminal, 200).width).toBe(46);
		// Multiple steps cannot hide one-off invalidation bugs.
		expect(measure(controller, terminal, 200).divider).toBe(200 - 46);
	});

	it("clamps the rendered pane at 34 and 60 columns", () => {
		stored.width = DEFAULT_WORKBENCH_WIDTH;
		const { controller, terminal } = createController();
		while (measure(controller, terminal, 165).width > 34) controller.resizeBy(-4);
		expect(measure(controller, terminal, 165).width).toBe(34);
		expect(controller.resizeBy(-4)).toBe(34); // stays clamped
		while (measure(controller, terminal, 165).width < 60) controller.resizeBy(4);
		expect(measure(controller, terminal, 165).width).toBe(60);
		expect(controller.resizeBy(4)).toBe(60); // stays clamped
	});

	it("a narrow terminal hides the pane; re-expanding restores the preferred width", () => {
		stored.width = DEFAULT_WORKBENCH_WIDTH + 4;
		const { controller, terminal } = createController();
		expect(measure(controller, terminal, 117).width).toBe(0); // auto-hidden
		expect(measure(controller, terminal, 165).width).toBe(DEFAULT_WORKBENCH_WIDTH + 4); // restored
	});
});
