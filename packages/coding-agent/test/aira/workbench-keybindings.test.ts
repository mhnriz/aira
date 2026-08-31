import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";

describe("Aira Workbench keybinding defaults (Phase 12)", () => {
	it("binds Ctrl+Shift+O to the Workbench toggle by default", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.workbench.toggle")).toEqual(["ctrl+shift+o"]);
	});

	it("preserves Ctrl+O for tool-output expansion", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.tools.expand")).toEqual(["ctrl+o"]);
	});

	it("keeps the session-tree filter cycle on Ctrl+O (context-scoped, unchanged)", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.tree.filter.cycleForward")).toContain("ctrl+o");
		expect(km.getKeys("app.tree.filter.cycleBackward")).toContain("shift+ctrl+o");
	});

	it("resolves all default bindings without conflicts", () => {
		const km = new KeybindingsManager();
		expect(km.getConflicts()).toEqual([]);
	});

	it("preserves a user customization without changing the Workbench binding", () => {
		const km = new KeybindingsManager({ "app.tools.expand": "alt+o" });
		expect(km.getKeys("app.tools.expand")).toEqual(["alt+o"]);
		expect(km.getKeys("app.workbench.toggle")).toEqual(["ctrl+shift+o"]);
	});
});
