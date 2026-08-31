/**
 * Aira Workbench — sidebar renderer.
 *
 * Renders the WorkbenchProjection (pure layer) into terminal lines using
 * SEMANTIC theme colors only (roles → active theme). Flat surface: a pane
 * title strip, panel headers, bounded rows, thin separators, optional
 * progress lines. No boxes, no borders around widgets, no Nerd Font glyphs.
 *
 * The component is height-aware: in regular (terminal-native) mode the rail
 * is viewport-fixed and drops lowest-priority overflow panels; in fullscreen
 * mode it sits inside a ScrollView and can scroll independently.
 */

import type { WorkbenchPanel, WorkbenchProjection, WorkbenchRole, WorkbenchRow } from "../../../aira/ui/types.ts";
import { theme } from "../theme/theme.ts";

/** Map a semantic role to the active theme color. */
export function roleColor(role: WorkbenchRole | undefined, text: string): string {
	switch (role) {
		case "copper":
			return theme.fg("copper", text);
		case "copperBright":
			return theme.fg("copperBright", text);
		case "blue":
			return theme.fg("blue", text);
		case "cyan":
			return theme.fg("cyan", text);
		case "green":
			return theme.fg("green", text);
		case "yellow":
			return theme.fg("yellow", text);
		case "red":
			return theme.fg("red", text);
		case "purple":
			return theme.fg("purple", text);
		case "muted":
			return theme.fg("muted", text);
		case "dim":
			return theme.fg("dim", text);
		default:
			return theme.fg("text", text);
	}
}

const LABEL_COLUMN = 10;

/** Deterministic separator line (thin, flat). */
function separatorLine(width: number): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(2, Math.min(width, 120))));
}

function renderRow(row: WorkbenchRow, width: number): string {
	const label = row.label !== undefined ? row.label.padEnd(Math.min(LABEL_COLUMN, Math.max(1, width)), " ") : "";
	const value = row.value;
	const trailing = row.trailing !== undefined ? ` ${row.trailing}` : "";
	const line = `${label}${roleColor(row.role, value)}${row.trailing ? roleColor(row.trailingRole ?? "muted", trailing) : ""}`;
	const detail = row.detail ? `\n${roleColor("muted", `  ${row.detail}`)}` : "";
	// Keep emitted rows bounded; the TUI clips cells beyond the width.
	const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
	const bounded =
		plain.length > width * 4
			? `${roleColor("muted", "…")}${plain.slice(plain.length - Math.max(1, width) + 1)}`
			: line;
	return `${bounded}${detail}`;
}

function renderProgress(
	progress: { value: number; role: "green" | "red" | "yellow" | "muted" },
	width: number,
): string {
	const barWidth = Math.min(24, Math.max(8, width - 2));
	const filled = Math.max(0, Math.min(barWidth, Math.round(progress.value * barWidth)));
	const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
	const pct = `${Math.round(progress.value * 100)}%`;
	return `${roleColor(progress.role, bar)} ${roleColor("muted", pct.padStart(4))}`;
}

export interface WorkbenchComponentOptions {
	/** Height provider for viewport-fixed rails (regular mode). */
	getHeight: () => number;
	/** When true, render the pane title strip (default true). */
	showTitle?: boolean;
}

export interface WorkbenchComponent {
	/** Replace the projection this component renders. */
	setProjection(projection: WorkbenchProjection | undefined): void;
	render(width: number): string[];
	invalidate(): void;
}

/** Deterministic panel count that fits the available height (priority order). */
export function fitPanelCount(panels: readonly WorkbenchPanel[], maxHeight: number, showTitle: boolean): number {
	let used = showTitle ? 1 : 0;
	let count = 0;
	for (const panel of panels) {
		const size = 1 + panel.rows.length + (panel.progress ? 1 : 0) + (count > 0 ? 1 : 0);
		if (used + size > maxHeight) break;
		used += size;
		count += 1;
	}
	return count;
}

/** Build the sidebar component (stateless renderer; projection pushed in). */
export function createWorkbenchComponent(options: WorkbenchComponentOptions): WorkbenchComponent {
	let projection: WorkbenchProjection | undefined;
	const showTitle = options.showTitle !== false;

	const renderProjection = (next: WorkbenchProjection, width: number, maxHeight: number): string[] => {
		const safeWidth = Math.max(4, Math.trunc(width));
		const fittedCount = fitPanelCount(next.panels, maxHeight, showTitle);
		const panels = fittedCount < next.panels.length ? next.panels.slice(0, fittedCount) : next.panels;
		const lines: string[] = [];
		if (showTitle) {
			lines.push(roleColor("muted", "AIRA WORKBENCH"));
		}
		for (const panel of panels) {
			if (lines.length > (showTitle ? 1 : 0)) {
				lines.push(separatorLine(safeWidth));
			}
			const hint = panel.hint ? `${roleColor("dim", ` · ${panel.hint}`)}` : "";
			lines.push(`${roleColor("muted", panel.title.toUpperCase())}${hint}`);
			for (const row of panel.rows) {
				lines.push(...renderRow(row, safeWidth).split("\n"));
			}
			if (panel.progress) {
				lines.push(renderProgress(panel.progress, safeWidth));
			}
		}
		return lines.slice(0, maxHeight);
	};

	return {
		setProjection(next: WorkbenchProjection | undefined): void {
			projection = next;
		},
		render(width: number): string[] {
			if (!projection) return [];
			const maxHeight = Math.max(1, Math.trunc(options.getHeight()));
			return renderProjection(projection, width, maxHeight);
		},
		invalidate(): void {
			// Stateless renderer: nothing to invalidate.
		},
	};
}
