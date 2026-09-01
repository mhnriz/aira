import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	private frameRule(width: number, side: "top" | "bottom", detail: string): string {
		const left = side === "top" ? "╭─ " : "╰─ ";
		const right = side === "top" ? "╮" : "╯";
		const label = side === "top" ? theme.bold(theme.fg("copper", "COMPOSE")) : theme.fg("muted", detail);
		const reserved = visibleWidth(left) + visibleWidth(label) + 1 + visibleWidth(right);
		if (reserved >= width) {
			return theme.fg(
				"borderAccent",
				`${side === "top" ? "╭" : "╰"}${"─".repeat(Math.max(0, width - 2))}${side === "top" ? "╮" : "╯"}`,
			);
		}
		return `${theme.fg("borderAccent", left)}${label}${theme.fg("borderAccent", ` ${"─".repeat(width - reserved)}${right}`)}`;
	}

	private isEditorBorder(line: string): boolean {
		const plain = stripAnsi(line);
		return /^─+$/.test(plain) || (/^─── [↑↓] /.test(plain) && plain.includes(" more "));
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(6, Math.trunc(width));
		const innerWidth = safeWidth - 2;
		const base = super.render(innerWidth);
		if (base.length === 0) return [];

		let bottomBorder = -1;
		for (let index = base.length - 1; index > 0; index -= 1) {
			if (this.isEditorBorder(base[index]!)) {
				bottomBorder = index;
				break;
			}
		}

		const submitKeys = this.keybindings.getKeys("tui.input.submit");
		const followUpKeys = this.keybindings.getKeys("app.message.followUp");
		const submit = submitKeys[0] ? formatKeyText(submitKeys[0]) : "enter";
		const followUp = followUpKeys[0] ? formatKeyText(followUpKeys[0]) : "";
		const detail = `${submit} send${followUp ? ` · ${followUp} follow-up` : ""} · / commands`;
		const lines = [this.frameRule(safeWidth, "top", "")];
		for (let index = 1; index < base.length; index += 1) {
			if (index === bottomBorder) continue;
			const clipped = truncateToWidth(base[index]!, innerWidth, theme.fg("dim", "…"));
			const padded = `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
			lines.push(
				`${theme.fg("borderAccent", "│")}${theme.bg("userMessageBg", padded)}${theme.fg("borderAccent", "│")}`,
			);
		}
		lines.push(this.frameRule(safeWidth, "bottom", detail));
		return lines;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
