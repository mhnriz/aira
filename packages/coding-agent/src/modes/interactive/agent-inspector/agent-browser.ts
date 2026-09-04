/**
 * Agent Inspector — Agent Browser component.
 *
 * The native child list shown in the LEFT conversation viewport when the user
 * presses Left on an empty composer. Renders the canonical orchestration
 * snapshot truthfully: active children first (running → waiting), then
 * recently settled runs (completed/failed/cancelled within bounded history).
 * Rows show role, bounded task summary, state/activity, and elapsed or the
 * failure reason. Selection is pure UI state; the component holds no
 * engineering truth and consumes no model tokens.
 *
 * Keys follow the existing selector conventions: Up/Down (tui.select.up/down),
 * Enter (tui.select.confirm), Esc (tui.select.cancel).
 */
import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AiraChildRun } from "../../../aira/orchestration/types.ts";
import { keyText } from "../components/keybinding-hints.ts";
import { theme } from "../theme/theme.ts";
import { inspectorElapsed, inspectorRunStatus, inspectorTaskSummary } from "./run-state.ts";

/** Rows shown at most (bounded; runs beyond this stay inspectable via history only). */
export const MAX_BROWSER_ROWS = 14;

export interface AgentBrowserRow {
	runId: string;
	/** "●" running · "○" waiting · "✕" failed/cancelled · "✓" completed. */
	glyph: string;
	role: string;
	task: string;
	state: string;
	detail?: string;
	elapsed?: string;
}

export interface AgentBrowserOptions {
	getRuns: () => readonly AiraChildRun[];
	getSummary: () => string | undefined;
	onSelect: (runId: string) => void;
	onCancel: () => void;
}

/** Order browser rows: active first, then settled (most recent first). */
export function orderBrowserRuns(runs: readonly AiraChildRun[]): AiraChildRun[] {
	const active: AiraChildRun[] = [];
	const waiting: AiraChildRun[] = [];
	const settled: AiraChildRun[] = [];
	for (const run of runs) {
		if (run.status === "running") {
			active.push(run);
		} else if (run.status === "pending") {
			waiting.push(run);
		} else {
			settled.push(run);
		}
	}
	active.sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt));
	waiting.sort((a, b) => a.createdAt - b.createdAt);
	settled.sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
	return [...active, ...waiting, ...settled].slice(0, MAX_BROWSER_ROWS);
}

export function toBrowserRow(run: AiraChildRun): AgentBrowserRow {
	const status = inspectorRunStatus(run);
	const glyph =
		run.status === "running" ? "●" : run.status === "pending" ? "○" : run.status === "completed" ? "✓" : "✕";
	return {
		runId: run.id,
		glyph,
		role: run.role,
		task: inspectorTaskSummary(run.task),
		state: status.label,
		detail: status.detail,
		// Elapsed only where it is truthful: running (live ticker) and settled
		// (duration). Waiting rows show their phase, never a misleading 0s.
		elapsed: run.status === "running" || run.phase === "settled" ? inspectorElapsed(run) : undefined,
	};
}

/** The Agent Browser: bounded child list with Up/Down/Enter/Esc navigation. */
export class AgentBrowserComponent implements Component, Focusable {
	private readonly options: AgentBrowserOptions;
	private rows: AgentBrowserRow[] = [];
	private selectedIndex = 0;
	private summary: string | undefined;
	focused = false;

	constructor(options: AgentBrowserOptions) {
		this.options = options;
	}

	/** Refresh from the manager's run records (call on snapshot change/tick). */
	refresh(): void {
		this.rows = orderBrowserRuns(this.options.getRuns()).map(toBrowserRow);
		if (this.selectedIndex >= this.rows.length) {
			this.selectedIndex = Math.max(0, this.rows.length - 1);
		}
		this.summary = this.options.getSummary();
	}

	getSelectedRunId(): string | undefined {
		return this.rows[this.selectedIndex]?.runId;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.rows.length > 0) {
				this.selectedIndex = (this.selectedIndex - 1 + this.rows.length) % this.rows.length;
			}
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.rows.length > 0) {
				this.selectedIndex = (this.selectedIndex + 1) % this.rows.length;
			}
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const runId = this.getSelectedRunId();
			if (runId) {
				this.options.onSelect(runId);
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}

	invalidate(): void {
		this.refresh();
	}

	render(width: number): string[] {
		this.refresh();
		const safeWidth = Math.max(4, Math.trunc(width));
		const lines: string[] = [];

		// --- header ---
		const counts = this.summary ?? "idle";
		const header = `${theme.bold(theme.fg("copper", "AGENTS"))} ${theme.fg("muted", counts)}`;
		lines.push(truncateToWidth(header, safeWidth, theme.fg("dim", "…")));
		lines.push(theme.fg("borderMuted", "─".repeat(safeWidth)));

		if (this.rows.length === 0) {
			lines.push(theme.fg("dim", "No children — dispatch agents with agents_delegate."));
		}

		// --- rows ---
		for (let index = 0; index < this.rows.length; index += 1) {
			const row = this.rows[index]!;
			const selected = index === this.selectedIndex;
			const marker = selected ? theme.fg("copperBright", "›") : theme.fg("dim", " ");
			const glyph = selected ? theme.fg(rowGlyphColor(row), row.glyph) : theme.fg(rowGlyphColor(row), row.glyph);
			const role = `${theme.fg("muted", row.role.padEnd(10))}`;
			const state = theme.fg(rowStateColor(row), row.state);
			const trailing = row.elapsed ? `  ${theme.fg("muted", row.elapsed)}` : "";
			const left = `${marker} ${glyph} ${role}${theme.fg("text", row.task)}`;
			lines.push(balancedRow(left, `${state}${trailing}`, safeWidth));
			if (selected && row.detail) {
				lines.push(
					truncateToWidth(
						`${theme.fg("dim", "   ")}${theme.fg("muted", row.detail)}`,
						safeWidth,
						theme.fg("dim", "…"),
					),
				);
			}
		}

		// --- hints ---
		lines.push("");
		const up = theme.fg("dim", keyText("tui.select.up"));
		const down = theme.fg("dim", keyText("tui.select.down"));
		const enter = theme.fg("dim", keyText("tui.select.confirm"));
		const esc = theme.fg("dim", keyText("tui.select.cancel"));
		lines.push(`${up} ${down} navigate · ${enter} view · ${esc} close`);
		return lines;
	}
}

function rowGlyphColor(row: AgentBrowserRow): "cyan" | "yellow" | "green" | "red" {
	switch (row.glyph) {
		case "●":
			return "cyan";
		case "○":
			return "yellow";
		case "✓":
			return "green";
		default:
			return "red";
	}
}

function rowStateColor(row: AgentBrowserRow): "cyan" | "yellow" | "green" | "red" | "muted" {
	if (row.state === "completed") return "green";
	if (row.state === "running" || row.state.startsWith("running")) return "cyan";
	if (row.state.startsWith("waiting")) return "yellow";
	if (
		row.state === "failed" ||
		row.state === "timed-out" ||
		row.state === "cancelled" ||
		row.state === "rejected" ||
		row.glyph === "✕"
	) {
		return "red";
	}
	return "muted";
}

/** Left/right balanced single line (bounded, width-stable). */
function balancedRow(left: string, right: string, width: number): string {
	const safeWidth = Math.max(1, Math.trunc(width));
	const rightWidth = Math.min(safeWidth, visibleWidth(right));
	const clippedRight = truncateToWidth(right, rightWidth, "");
	const leftWidth = Math.max(0, safeWidth - visibleWidth(clippedRight) - 1);
	const clippedLeft = truncateToWidth(left, leftWidth, theme.fg("dim", "…"));
	const gap = " ".repeat(Math.max(1, safeWidth - visibleWidth(clippedLeft) - visibleWidth(clippedRight)));
	return truncateToWidth(`${clippedLeft}${gap}${clippedRight}`, safeWidth, "");
}
