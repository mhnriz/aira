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

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

const RAIL_PREFIX = 3;

function contentWidth(width: number): number {
	return Math.max(1, width - RAIL_PREFIX);
}

/** Apply the persistent pane edge and make every overlay line width-stable. */
function railLine(value: string, width: number, edge = "│"): string {
	const safeWidth = Math.max(1, Math.trunc(width));
	if (safeWidth === 1) return theme.fg("borderMuted", edge);
	const innerWidth = contentWidth(safeWidth);
	const clipped = truncateToWidth(value, innerWidth, roleColor("dim", "…"));
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return truncateToWidth(`${theme.fg("borderMuted", edge)}  ${clipped}${padding}`, safeWidth, "");
}

function spacedRow(left: string, right: string | undefined, width: number): string {
	if (!right) return truncateToWidth(left, width, roleColor("dim", "…"));
	const rightWidth = Math.min(width, visibleWidth(right));
	const safeRight = truncateToWidth(right, rightWidth, "");
	const leftWidth = Math.max(0, width - visibleWidth(safeRight) - 1);
	const safeLeft = truncateToWidth(left, leftWidth, roleColor("dim", "…"));
	const gap = " ".repeat(Math.max(1, width - visibleWidth(safeLeft) - visibleWidth(safeRight)));
	return truncateToWidth(`${safeLeft}${gap}${safeRight}`, width, "");
}

function renderRow(row: WorkbenchRow, width: number): string[] {
	const labelWidth = row.label === undefined ? 0 : Math.min(11, Math.max(7, Math.floor(width * 0.3)));
	const label =
		row.label === undefined
			? ""
			: `${roleColor("muted", truncateToWidth(row.label, labelWidth, "…").padEnd(labelWidth, " "))} `;
	const left = `${label}${roleColor(row.role, row.value)}`;
	const trailing = row.trailing ? roleColor(row.trailingRole ?? "muted", row.trailing) : undefined;
	const lines = [spacedRow(left, trailing, width)];
	if (row.detail) {
		const indent = " ".repeat(row.label === undefined ? 2 : Math.min(labelWidth + 1, Math.max(0, width - 1)));
		lines.push(truncateToWidth(`${indent}${roleColor("muted", row.detail)}`, width, roleColor("dim", "…")));
	}
	return lines;
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
	/** Fill unused viewport rows so the regular-mode pane edge stays continuous. */
	fillHeight?: () => boolean;
}

export interface WorkbenchComponent {
	/** Replace the projection this component renders. */
	setProjection(projection: WorkbenchProjection | undefined): void;
	render(width: number): string[];
	invalidate(): void;
}

/** Deterministic panel count that fits the available height (priority order). */
export function fitPanelCount(panels: readonly WorkbenchPanel[], maxHeight: number, showTitle: boolean): number {
	let used = showTitle ? 3 : 0;
	let count = 0;
	for (const panel of panels) {
		const rowLines = panel.rows.reduce((sum, row) => sum + (row.detail ? 2 : 1), 0);
		const size = 1 + rowLines + (panel.progress ? 1 : 0) + (count > 0 ? 1 : 0);
		if (used + size > maxHeight) break;
		used += size;
		count += 1;
	}
	return count;
}

/** Pure terminal rendering of one pushed projection (exported for visual regression tests). */
export function renderWorkbenchProjection(
	next: WorkbenchProjection,
	width: number,
	maxHeight: number,
	showTitle = true,
): string[] {
	const safeWidth = Math.max(4, Math.trunc(width));
	const innerWidth = contentWidth(safeWidth);
	const fittedCount = fitPanelCount(next.panels, maxHeight, showTitle);
	const panels = fittedCount < next.panels.length ? next.panels.slice(0, fittedCount) : next.panels;
	const lines: string[] = [];
	if (showTitle) {
		lines.push(
			railLine(
				`${theme.bold(roleColor("text", "ENGINEERING"))} ${theme.bold(roleColor("copper", "CONTEXT"))}`,
				safeWidth,
			),
		);
		lines.push(railLine(roleColor("dim", "CANONICAL STATE · TOKEN-FREE"), safeWidth));
		lines.push(railLine(theme.fg("borderMuted", "─".repeat(innerWidth)), safeWidth, "├"));
	}
	for (const panel of panels) {
		if (lines.length > (showTitle ? 3 : 0)) lines.push(railLine("", safeWidth));
		const title = theme.bold(roleColor("text", panel.title.toUpperCase()));
		const hint = panel.hint ? roleColor("dim", panel.hint) : undefined;
		lines.push(railLine(spacedRow(title, hint, innerWidth), safeWidth));
		for (const row of panel.rows) {
			for (const line of renderRow(row, innerWidth)) lines.push(railLine(line, safeWidth));
		}
		if (panel.progress) lines.push(railLine(renderProgress(panel.progress, innerWidth), safeWidth));
	}
	return lines.slice(0, Math.max(1, maxHeight));
}

/** Build the sidebar component (stateless renderer; projection pushed in). */
export function createWorkbenchComponent(options: WorkbenchComponentOptions): WorkbenchComponent {
	let projection: WorkbenchProjection | undefined;
	const showTitle = options.showTitle !== false;

	return {
		setProjection(next: WorkbenchProjection | undefined): void {
			projection = next;
		},
		render(width: number): string[] {
			if (!projection) return [];
			const maxHeight = Math.max(1, Math.trunc(options.getHeight()));
			const lines = renderWorkbenchProjection(projection, width, maxHeight, showTitle);
			if (options.fillHeight?.()) {
				while (lines.length < maxHeight) lines.push(railLine("", Math.max(4, Math.trunc(width))));
			}
			return lines;
		},
		invalidate(): void {
			// Stateless renderer: nothing to invalidate.
		},
	};
}
