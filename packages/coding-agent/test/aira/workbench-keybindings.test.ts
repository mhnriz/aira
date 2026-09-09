import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";

describe("Aira Workbench keybinding defaults (Phase 12)", () => {
	it("binds Alt+Backslash to the Session Context toggle by default", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.workbench.toggle")).toEqual(["alt+\\"]);
	});

	it("no longer ships the Ctrl+Shift+O secondary toggle (Windows Terminal folds it into Ctrl+O)", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.workbench.toggle")).not.toContain("ctrl+shift+o");
		expect(km.getKeys("app.workbench.toggle")).not.toContain("shift+ctrl+o");
	});

	it("preserves Ctrl+O for tool-output expansion", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.tools.expand")).toEqual(["ctrl+o"]);
	});

	it("keeps the session-tree filter cycle on Ctrl+O (context-scoped, unchanged)", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.tree.filter.cycleForward")).toContain("ctrl+o");
		expect(km.getKeys("app.tree.filter.cycleBackward")).toContain("ctrl+alt+o");
		expect(km.getKeys("app.tree.filter.cycleBackward")).not.toContain("shift+ctrl+o");
	});

	it("resolves all default bindings without conflicts", () => {
		const km = new KeybindingsManager();
		expect(km.getConflicts()).toEqual([]);
	});

	it("preserves a user customization without changing the Workbench binding", () => {
		const km = new KeybindingsManager({ "app.tools.expand": "alt+o" });
		expect(km.getKeys("app.tools.expand")).toEqual(["alt+o"]);
		expect(km.getKeys("app.workbench.toggle")).toEqual(["alt+\\"]);
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
			expect(km.getKeys("app.workbench.toggle")).toEqual(["alt+\\"]);
			expect(km.getKeys("app.viewport.focusCycle")).toEqual(["alt+o"]);
		});

		it("resolves the new default binding without conflicts", () => {
			const km = new KeybindingsManager();
			expect(km.getConflicts()).toEqual([]);
		});

		it("keeps the Workbench toggle binding intact alongside focus cycle", () => {
			const km = new KeybindingsManager();
			expect(km.getKeys("app.workbench.toggle")).toEqual(["alt+\\"]);
			expect(km.getKeys("app.viewport.focusCycle")).toEqual(["alt+o"]);
		});
	});
});

describe("Aira Workbench keyboard resize/hide bindings", () => {
	it("binds wider to Alt+] and narrower to Alt+[ by default", () => {
		const km = new KeybindingsManager();
		expect(km.getKeys("app.workbench.wider")).toEqual(["alt+]"]);
		expect(km.getKeys("app.workbench.narrower")).toEqual(["alt+["]);
	});

	it("matches the legacy ESC+symbol byte sequences through the real input layer", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x1b[", "app.workbench.narrower")).toBe(true);
		expect(km.matches("\x1b]", "app.workbench.wider")).toBe(true);
		expect(km.matches("\x1b\\", "app.workbench.toggle")).toBe(true);
	});

	it("matches the kitty CSI-u sequences for the same chords", () => {
		const km = new KeybindingsManager();
		// ESC [ 91 ; 3 u = `[` with alt; 93 = `]`; 92 = `\\`.
		expect(km.matches("\x1b[91;3u", "app.workbench.narrower")).toBe(true);
		expect(km.matches("\x1b[93;3u", "app.workbench.wider")).toBe(true);
		expect(km.matches("\x1b[92;3u", "app.workbench.toggle")).toBe(true);
	});

	it("keeps the three workbench chords distinct from each other", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x1b[", "app.workbench.wider")).toBe(false);
		expect(km.matches("\x1b[", "app.workbench.toggle")).toBe(false);
		expect(km.matches("\x1b]", "app.workbench.narrower")).toBe(false);
		expect(km.matches("\x1b]", "app.workbench.toggle")).toBe(false);
		expect(km.matches("\x1b\\", "app.workbench.wider")).toBe(false);
		expect(km.matches("\x1b\\", "app.workbench.narrower")).toBe(false);
	});

	it("does not collide with editor or viewport bindings", () => {
		const km = new KeybindingsManager();
		// The bracket/backslash chords must not be claimed by any other action.
		const wider = km.getKeys("app.workbench.wider");
		const narrower = km.getKeys("app.workbench.narrower");
		const toggle = km.getKeys("app.workbench.toggle");
		expect(wider.some((key) => narrower.includes(key) || toggle.includes(key))).toBe(false);
		expect(narrower.some((key) => wider.includes(key) || toggle.includes(key))).toBe(false);
		expect(km.getConflicts()).toEqual([]);
	});

	it("does not leak the resize chords into the composer", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let resized = 0;
		editor.onAction("app.workbench.wider", () => {
			resized += 4;
		});
		editor.onAction("app.workbench.narrower", () => {
			resized -= 4;
		});

		editor.setText("draft");
		editor.handleInput("\x1b]");
		expect(editor.getText()).toBe("draft");
		expect(resized).toBe(4);

		editor.handleInput("\x1b[");
		expect(editor.getText()).toBe("draft");
		expect(resized).toBe(0);
	});
});
