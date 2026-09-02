import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Which pane receives unmodified keyboard viewport navigation. */
export type ViewportFocus = "conversation" | "workbench";

export interface AiraHeaderState {
	mode: string;
	cwd: string;
	branch?: string;
	model: string;
	thinking?: string;
	session?: string;
	controls: string;
}

function balancedLine(left: string, right: string, width: number): string {
	const safeWidth = Math.max(1, Math.trunc(width));
	const rightWidth = Math.min(safeWidth, visibleWidth(right));
	const clippedRight = truncateToWidth(right, rightWidth, "");
	const leftWidth = Math.max(0, safeWidth - visibleWidth(clippedRight) - 1);
	const clippedLeft = truncateToWidth(left, leftWidth, theme.fg("dim", "…"));
	const gap = " ".repeat(Math.max(1, safeWidth - visibleWidth(clippedLeft) - visibleWidth(clippedRight)));
	return truncateToWidth(`${clippedLeft}${gap}${clippedRight}`, safeWidth, "");
}

/**
 * Aira-owned conversation pane title. A subtle copper focus mark appears next
 * to the title while the conversation pane is the keyboard scroll target.
 */
export class AiraConversationTitleComponent implements Component {
	private readonly getFocused: () => boolean;

	constructor(getFocused: () => boolean) {
		this.getFocused = getFocused;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.trunc(width));
		const title = this.getFocused()
			? `${theme.bold(theme.fg("text", "CONVERSATION"))} ${theme.fg("copperBright", "●")}`
			: theme.bold(theme.fg("text", "CONVERSATION"));
		return [truncateToWidth(title, safeWidth, theme.fg("dim", "…")), theme.fg("borderMuted", "─".repeat(safeWidth))];
	}
}

/**
 * Bottom-of-conversation new-output indicator. Renders zero lines (no layout
 * space) until the transcript viewport is scrolled away from live output.
 */
export class AiraNewOutputIndicatorComponent implements Component {
	private readonly getUnread: () => number;

	constructor(getUnread: () => number) {
		this.getUnread = getUnread;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const unread = this.getUnread();
		if (unread <= 0) return [];
		const safeWidth = Math.max(1, Math.trunc(width));
		const label = `↓ ${unread} new ${unread === 1 ? "line" : "lines"}`;
		return [theme.fg("muted", truncateToWidth(label, safeWidth, theme.fg("dim", "…")))];
	}
}

/** Aira-owned application header. It replaces the stock startup/help block. */
export class AiraHeaderComponent implements Component {
	private expanded = false;
	private readonly getState: () => AiraHeaderState;

	constructor(getState: () => AiraHeaderState) {
		this.getState = getState;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.trunc(width));
		const state = this.getState();
		const product = `${theme.bold(theme.fg("copper", "AIRA"))} ${theme.bold(theme.fg("text", "WORKBENCH"))}`;
		const mode = theme.bold(theme.fg("copperBright", state.mode.toUpperCase()));
		const session = state.session ? theme.fg("muted", state.session) : theme.fg("dim", "SESSION");
		const location = theme.fg("thinkingText", `${state.cwd}${state.branch ? ` · ${state.branch}` : ""}`);
		const model = theme.fg("muted", `${state.model}${state.thinking ? ` · ${state.thinking}` : ""}`);
		const detail = this.expanded ? theme.fg("muted", state.controls) : model;

		if (safeWidth < 48) {
			return [
				balancedLine(product, mode, safeWidth),
				truncateToWidth(location, safeWidth, theme.fg("dim", "…")),
				theme.fg("borderMuted", "─".repeat(safeWidth)),
			];
		}

		return [
			balancedLine(product, `${mode} ${theme.fg("borderMuted", "·")} ${session}`, safeWidth),
			balancedLine(location, detail, safeWidth),
			theme.fg("borderMuted", "─".repeat(safeWidth)),
		];
	}
}

export type AiraNoticeKind = "status" | "warning" | "error" | "update";

const NOTICE_STYLE: Record<
	AiraNoticeKind,
	{ marker: string; label: string; color: "blue" | "yellow" | "red" | "copper" }
> = {
	status: { marker: "·", label: "AIRA", color: "blue" },
	warning: { marker: "!", label: "NOTICE", color: "yellow" },
	error: { marker: "×", label: "ERROR", color: "red" },
	update: { marker: "↑", label: "UPDATE", color: "copper" },
};

/** Compact transcript notice used for status, warnings, errors, and updates. */
export class AiraNoticeComponent implements Component {
	private text: string;
	private readonly kind: AiraNoticeKind;

	constructor(text: string, kind: AiraNoticeKind) {
		this.text = text;
		this.kind = kind;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const style = NOTICE_STYLE[this.kind];
		const prefix = `${theme.fg(style.color, style.marker)} ${theme.bold(theme.fg(style.color, style.label))} `;
		return [truncateToWidth(`${prefix}${theme.fg("muted", this.text)}`, Math.max(1, width), theme.fg("dim", "…"))];
	}
}
