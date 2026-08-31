import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";

describe("Aira Workbench keybinding defaults (Phase 12)", () => {
	it("binds Ctrl+O to the Workbench toggle by default", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.workbench.toggle")).toEqual(["ctrl+o"]);
	});

	it("moved tool-output expansion off Ctrl+O to Alt+O by default", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.tools.expand")).toEqual(["alt+o"]);
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

	it("preserves a user customization of tool expansion even after the default moved", () => {
		// A user who had bound ctrl+o to tools.expand keeps it: user bindings
		// override defaults and are never overwritten by the default change.
		const km = new KeybindingsManager({ "app.tools.expand": "ctrl+o" });
		expect(km.getKeys("app.tools.expand")).toEqual(["ctrl+o"]);
		// The toggle also keeps its default; the two actions share the key only
		// under the user's explicit choice (documented; the editor dispatches
		// in registration order and the custom binding wins for expansion).
		expect(km.getKeys("app.workbench.toggle")).toEqual(["ctrl+o"]);
	});
});
