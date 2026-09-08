import { setPasteGestureClock, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

/**
 * Paste-expansion gesture wired through the composer's Ctrl+V keybinding.
 * The first Ctrl+V performs an ordinary paste; a second Ctrl+V inside the
 * gesture window expands the preceding collapsed paste in place without
 * reading the clipboard again.
 */
describe("CustomEditor paste expansion gesture (Ctrl+V)", () => {
	// Deterministic fake clock: no sleeping in tests.
	let clock = 0;
	beforeEach(() => {
		clock = 0;
		setPasteGestureClock(() => clock);
	});
	afterEach(() => {
		setPasteGestureClock(() => Date.now());
	});

	function createEditor(): { editor: CustomEditor; pasteCount: () => number } {
		const keybindings = new KeybindingsManager({ "app.clipboard.pasteImage": "ctrl+v" });
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme, keybindings);
		let count = 0;
		editor.onPasteImage = () => {
			count += 1;
		};
		return { editor, pasteCount: () => count };
	}

	function bigPaste(tag: string): string {
		return Array.from({ length: 12 }, (_, i) => `${tag}${i}`).join("\n");
	}

	const bracketed = (content: string) => `\x1b[200~${content}\x1b[201~`;

	it("expands the preceding collapsed paste on a second Ctrl+V without touching the clipboard", () => {
		const { editor, pasteCount } = createEditor();
		const content = bigPaste("alpha");
		editor.handleInput(bracketed(content));
		expect(editor.getText()).toMatch(/^\[paste #\d+ \+\d+ lines\]$/);

		// Second Ctrl+V inside the window: the press is consumed by the
		// gesture, so the host's clipboard read never happens.
		editor.handleInput("\x16"); // Ctrl+V
		expect(editor.getText()).toBe(content);
		expect(pasteCount()).toBe(0);
	});

	it("reads the clipboard for an ordinary first Ctrl+V when there is no collapsed paste", () => {
		const { editor, pasteCount } = createEditor();
		editor.handleInput("\x16"); // Ctrl+V
		expect(pasteCount()).toBe(1);
	});

	it("falls back to an ordinary paste after the gesture window expires", () => {
		const { editor, pasteCount } = createEditor();
		editor.handleInput(bracketed(bigPaste("alpha")));

		clock += 1001;
		editor.handleInput("\x16"); // Ctrl+V
		expect(pasteCount()).toBe(1);
	});

	it("falls back to an ordinary paste after an intervening edit", () => {
		const { editor, pasteCount } = createEditor();
		editor.handleInput(bracketed(bigPaste("alpha")));
		editor.handleInput("X");

		editor.handleInput("\x16"); // Ctrl+V
		expect(pasteCount()).toBe(1);
	});

	it("falls back to an ordinary paste after cursor movement", () => {
		const { editor, pasteCount } = createEditor();
		editor.handleInput(bracketed(bigPaste("alpha")));
		editor.handleInput("\x1b[D"); // left arrow

		editor.handleInput("\x16"); // Ctrl+V
		expect(pasteCount()).toBe(1);
	});

	it("does not read the clipboard when a queued expansion is in flight", () => {
		const { editor, pasteCount } = createEditor();
		// First Ctrl+V: ordinary paste press, clipboard read starts (async).
		editor.handleInput("\x16");
		expect(pasteCount()).toBe(1);

		// Second Ctrl+V before the clipboard read resolves: consumed and queued.
		editor.handleInput("\x16");
		expect(pasteCount()).toBe(1);

		// The clipboard read resolves and the paste lands; it collapses and
		// immediately expands so the full text appears exactly once.
		const content = bigPaste("alpha");
		editor.handleInput(bracketed(content));
		expect(editor.getText()).toBe(content);
	});

	it("allows the toggle back to collapsed form on a further Ctrl+V", () => {
		const { editor, pasteCount } = createEditor();
		const content = bigPaste("alpha");
		editor.handleInput(bracketed(content));

		editor.handleInput("\x16"); // expand
		expect(editor.getText()).toBe(content);
		editor.handleInput("\x16"); // re-collapse
		expect(editor.getText()).toMatch(/^\[paste #\d+ \+\d+ lines\]$/);
		expect(pasteCount()).toBe(0);
	});

	it("consumes a remapped paste keybinding the same way", () => {
		// User remapped the paste action (e.g. Windows users may bind alt+v):
		// the gesture still consumes the press without a clipboard read.
		const keybindings = new KeybindingsManager({ "app.clipboard.pasteImage": "ctrl+p" });
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme, keybindings);
		const pasteImage = vi.fn();
		editor.onPasteImage = pasteImage;
		const content = bigPaste("alpha");
		editor.handleInput(bracketed(content));
		editor.handleInput("\x10"); // ctrl+p (the remapped paste key)
		expect(editor.getText()).toBe(content);
		expect(pasteImage).not.toHaveBeenCalled();
	});
});
