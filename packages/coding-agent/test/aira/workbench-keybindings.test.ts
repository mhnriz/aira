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

	describe("Phase 12.1 viewport focus", () => {
		it("binds app.viewport.focusCycle to alt+o by default", () => {
			const km = new KeybindingsManager();
			expect(km.getKeys("app.viewport.focusCycle")).toEqual(["alt+o"]);
		});

		it("does not steal Ctrl+A (editor line-start / model / tree actions stay put)", () => {
			const km = new KeybindingsManager();
			expect(km.getKeys("app.viewport.focusCycle")).not.toContain("ctrl+a");
			expect(km.getKeys("tui.editor.cursorLineStart")).toContain("ctrl+a");
			expect(km.getKeys("app.models.enableAll")).toEqual(["ctrl+a"]);
			expect(km.getKeys("app.tree.filter.all")).toEqual(["ctrl+a"]);
		});

		it("keeps the O-family bindings distinct (expand / toggle / focus)", () => {
			const km = new KeybindingsManager();
			expect(km.getKeys("app.tools.expand")).toEqual(["ctrl+o"]);
			expect(km.getKeys("app.workbench.toggle")).toEqual(["ctrl+shift+o"]);
			expect(km.getKeys("app.viewport.focusCycle")).toEqual(["alt+o"]);
		});

		it("resolves the new default binding without conflicts", () => {
			const km = new KeybindingsManager();
			expect(km.getConflicts()).toEqual([]);
		});

		it("keeps the Workbench toggle binding intact alongside focus cycle", () => {
			const km = new KeybindingsManager();
			expect(km.getKeys("app.workbench.toggle")).toEqual(["ctrl+shift+o"]);
			expect(km.getKeys("app.viewport.focusCycle")).toEqual(["alt+o"]);
		});
	});
});
