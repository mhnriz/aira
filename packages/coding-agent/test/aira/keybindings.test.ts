import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";

describe("Aira mode keybinding defaults", () => {
	it("owns Shift+Tab for the mode cycle by default", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.mode.cycle")).toEqual(["shift+tab"]);
	});

	it("moved the thinking cycle off Shift+Tab to Ctrl+Shift+E by default", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.thinking.cycle")).toEqual(["ctrl+shift+e"]);
	});

	it("preserves a user customization of the thinking cycle even after the default moved", () => {
		// A user who had bound shift+tab to thinking.cycle keeps it: user bindings
		// override defaults and are never overwritten by the default change.
		const km = new KeybindingsManager({ "app.thinking.cycle": "shift+tab" });
		expect(km.getKeys("app.thinking.cycle")).toEqual(["shift+tab"]);
	});

	it("resolves both bindings under a fresh default config without overlap", () => {
		const km = new KeybindingsManager();
		const resolved = km.getResolvedBindings();
		expect(resolved["app.mode.cycle"]).toBe("shift+tab");
		expect(resolved["app.thinking.cycle"]).toBe("ctrl+shift+e");
		// No keybinding conflict is reported between the two defaults.
		expect(km.getConflicts()).toEqual([]);
	});
});
