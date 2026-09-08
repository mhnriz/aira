import { describe, expect, it, vi } from "vitest";
import { workbenchSafeMinimum } from "../../src/aira/ui/visibility.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { DEFAULT_WORKBENCH_WIDTH, MAX_WORKBENCH_WIDTH, MIN_WORKBENCH_WIDTH } from "../../src/core/settings-manager.ts";
import {
	WorkbenchController,
	type WorkbenchControllerOptions,
} from "../../src/modes/interactive/workbench/controller.ts";

type WorkbenchSettings = {
	enabled: boolean;
	showOnStartup: boolean;
	density: "comfortable" | "compact";
	width: number;
};

// The safe minimum is MIN_WORKBENCH_MAIN_WIDTH + sidebar width (72 + width).
const MIN_WORKBENCH_MAIN_WIDTH = 72;

function createFakeSession(initial: WorkbenchSettings): {
	session: AgentSession;
	stored: WorkbenchSettings;
} {
	const stored = { ...initial };
	const setWorkbenchSettings = vi.fn((patch: Partial<WorkbenchSettings>): void => {
		Object.assign(stored, patch);
	});
	const session = {
		sessionId: "test-session-no-aira-state",
		settingsManager: {
			getWorkbenchSettings: vi.fn(() => ({ ...stored })),
			setWorkbenchSettings,
			getFullscreenScrollbar: () => false,
		},
	} as unknown as AgentSession;
	return { session, stored };
}

function createController(
	overrides: Partial<WorkbenchControllerOptions> = {},
	initial: WorkbenchSettings = {
		enabled: true,
		showOnStartup: true,
		density: "comfortable",
		width: DEFAULT_WORKBENCH_WIDTH,
	},
): { controller: WorkbenchController; stored: WorkbenchSettings; layoutChanged: ReturnType<typeof vi.fn> } {
	const { session, stored } = createFakeSession(initial);
	const options: WorkbenchControllerOptions = {
		session,
		footerComponent: {} as WorkbenchControllerOptions["footerComponent"],
		dockAnchorComponent: {} as WorkbenchControllerOptions["dockAnchorComponent"],
		getBranch: () => undefined,
		getFooterLineCount: () => 2,
		getTranscriptFollowing: () => true,
		getFocused: () => false,
		getInspectedRunId: () => undefined,
		requestRender: vi.fn(),
		invalidate: vi.fn(),
		layoutChanged: vi.fn(),
		...overrides,
	};
	return {
		controller: new WorkbenchController(options),
		stored,
		layoutChanged: options.layoutChanged as ReturnType<typeof vi.fn>,
	};
}

describe("Workbench controller keyboard resize", () => {
	it("widen/narrow in fixed 4-column steps from the preferred width", () => {
		const { controller } = createController();
		expect(controller.resizeBy(4)).toBe(DEFAULT_WORKBENCH_WIDTH + 4);
		expect(controller.resizeBy(-4)).toBe(DEFAULT_WORKBENCH_WIDTH);
	});

	it("step is 4 regardless of the raw delta magnitude", () => {
		const { controller } = createController();
		expect(controller.resizeBy(1)).toBe(DEFAULT_WORKBENCH_WIDTH + 4);
		expect(controller.resizeBy(10)).toBe(DEFAULT_WORKBENCH_WIDTH + 8);
	});

	it("clamps at the safe minimum width", () => {
		const { controller } = createController(undefined, {
			enabled: true,
			showOnStartup: true,
			density: "comfortable",
			width: MIN_WORKBENCH_WIDTH,
		});
		expect(controller.resizeBy(-4)).toBe(MIN_WORKBENCH_WIDTH);
	});

	it("clamps at the safe maximum width", () => {
		const { controller } = createController(undefined, {
			enabled: true,
			showOnStartup: true,
			density: "comfortable",
			width: MAX_WORKBENCH_WIDTH,
		});
		expect(controller.resizeBy(4)).toBe(MAX_WORKBENCH_WIDTH);
	});

	it("persists the new preferred width through the settings manager", () => {
		const { controller, stored } = createController();
		controller.resizeBy(4);
		expect(stored.width).toBe(DEFAULT_WORKBENCH_WIDTH + 4);
		controller.resizeBy(-4);
		expect(stored.width).toBe(DEFAULT_WORKBENCH_WIDTH);
	});

	it("does not persist anything when already at the clamp", () => {
		const { controller, stored } = createController();
		controller.resizeBy(4); // 46
		// Pump to the max clamp via repeated widens.
		while (controller.resizeBy(4) < MAX_WORKBENCH_WIDTH) {
			// no-op loop
		}
		expect(stored.width).toBe(MAX_WORKBENCH_WIDTH);
		controller.resizeBy(4);
		expect(stored.width).toBe(MAX_WORKBENCH_WIDTH);
	});

	it("asks the host to rebuild the fullscreen layout on resize", () => {
		const { controller, layoutChanged } = createController();
		controller.resizeBy(4);
		expect(layoutChanged).toHaveBeenCalled();
	});

	it("resizing never changes visibility state", () => {
		const { controller } = createController();
		controller.setVisible(false);
		controller.resizeBy(4);
		expect(controller.getExplicitVisible()).toBe(false);
		expect(controller.visibleAt(200)).toBe(false);
	});
});

describe("Workbench controller preferred vs effective width", () => {
	it("effective width matches preferred on comfortable terminals", () => {
		const { controller } = createController();
		controller.resizeBy(4);
		expect(controller.sidebarWidthFor(160)).toBe(DEFAULT_WORKBENCH_WIDTH + 4);
	});

	it("a narrow terminal auto-hides and never overwrites the preferred width", () => {
		const { controller, stored } = createController();
		controller.resizeBy(4); // 46
		const narrow = DEFAULT_WORKBENCH_WIDTH + 4 + MIN_WORKBENCH_MAIN_WIDTH - 1;
		expect(controller.visibleAt(narrow)).toBe(false);
		expect(controller.sidebarWidthFor(narrow)).toBe(0);
		expect(stored.width).toBe(DEFAULT_WORKBENCH_WIDTH + 4);
	});

	it("re-expanding the terminal restores the preferred width", () => {
		const { controller } = createController();
		controller.resizeBy(4); // 46; safe minimum becomes 72 + 46 = 118.
		expect(controller.sidebarWidthFor(117)).toBe(0);
		expect(controller.sidebarWidthFor(118)).toBe(DEFAULT_WORKBENCH_WIDTH + 4);
		expect(controller.sidebarWidthFor(160)).toBe(DEFAULT_WORKBENCH_WIDTH + 4);
	});

	it("responsive growth on very wide terminals grows the effective width only", () => {
		const { controller, stored } = createController();
		controller.resizeBy(4); // 46
		const wide = 200 + 30;
		const effective = controller.sidebarWidthFor(wide);
		expect(effective).toBeGreaterThan(DEFAULT_WORKBENCH_WIDTH + 4);
		expect(stored.width).toBe(DEFAULT_WORKBENCH_WIDTH + 4);
	});

	it("a wider preferred width raises the narrow auto-hide threshold", () => {
		const { controller } = createController();
		const before = workbenchSafeMinimum(DEFAULT_WORKBENCH_WIDTH);
		controller.resizeBy(4);
		expect(workbenchSafeMinimum(controller.resizeBy(0))).toBeGreaterThan(before);
	});
});
