/**
 * Agent Inspector — child transcript component.
 *
 * Renders ONE child's bounded event buffer in the LEFT conversation viewport
 * (the Workbench pane stays the root session's live canonical state). The
 * component is READ-ONLY: it has no composer, no input path into the child.
 *
 * Rendering mirrors the Aira conversation visual language: compact tool rows
 * via the shared compact-row builder (✓ read path / ✕ bash cmd), bounded
 * text/thinking blocks, truthful status/failure/completion lines. Full tool
 * outputs are never dumped — failures and permission denials show their
 * bounded reason. Rows are cached per width and invalidated on events, so a
 * live stream repaints only what changed.
 *
 * Esc (tui.select.cancel) closes the view and returns to the root
 * conversation directly.
 */
import {
	type Component,
	type Focusable,
	getKeybindings,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AiraChildEvent } from "../../../aira/orchestration/events.ts";
import type { AiraChildRun } from "../../../aira/orchestration/types.ts";
import { buildCompactRow } from "../../../core/tools/compact.ts";
import { theme } from "../theme/theme.ts";
import { inspectorElapsed, inspectorRunStatus } from "./run-state.ts";

export interface AgentTranscriptOptions {
	getRun: () => AiraChildRun | undefined;
	getEvents: () => readonly AiraChildEvent[];
	getElapsedNow: () => number;
	onCancel: () => void;
}

/** Tools whose compact target renders as a path (accent) rather than text. */
const PATH_TARGET_TOOLS = new Set(["read", "edit", "write", "ls", "grep", "find"]);

/** One rendered tool-call row awaiting its result (status flip on result). */
interface PendingToolRow {
	index: number;
	name: string;
	target: string;
}

export class AgentTranscriptComponent implements Component, Focusable {
	private readonly options: AgentTranscriptOptions;
	private version = 0;
	private cachedWidth = -1;
	private cachedVersion = -1;
	private cachedLines: string[] = [];
	focused = false;

	constructor(options: AgentTranscriptOptions) {
		this.options = options;
	}

	/** Invalidate the cached rendering (call on new events / status changes). */
	refresh(): void {
		this.version += 1;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		}
		// Everything else (arrows, typing) is deliberately ignored: the view is
		// read-only; viewport scrolling flows through the existing ScrollView.
	}

	invalidate(): void {
		this.refresh();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(4, Math.trunc(width));
		if (this.cachedWidth === safeWidth && this.cachedVersion === this.version && this.cachedLines.length > 0) {
			return this.cachedLines;
		}
		const lines = this.buildLines(safeWidth);
		this.cachedWidth = safeWidth;
		this.cachedVersion = this.version;
		this.cachedLines = lines;
		return lines;
	}

	private buildLines(width: number): string[] {
		const run = this.options.getRun();
		const lines: string[] = [];
		const header = this.headerLines(run, width);
		lines.push(...header);

		const pending = new Map<string, PendingToolRow>();
		for (const event of this.options.getEvents()) {
			this.appendEvent(lines, event, pending, width);
		}
		return lines;
	}

	private headerLines(run: AiraChildRun | undefined, width: number): string[] {
		const lines: string[] = [];
		if (!run) {
			lines.push(theme.fg("dim", "child no longer available"));
			lines.push(theme.fg("borderMuted", "─".repeat(width)));
			return lines;
		}
		const status = inspectorRunStatus(run);
		const title = `${theme.bold(theme.fg("copper", "AGENT"))} ${theme.bold(theme.fg("text", `· ${run.role.toUpperCase()}`))}`;
		lines.push(truncateToWidth(title, width, theme.fg("dim", "…")));
		lines.push(truncateToWidth(theme.fg("muted", run.task), width, theme.fg("dim", "…")));
		const statusParts = [theme.fg(statusColor(status.role), status.label)];
		if (run.status === "running") {
			const elapsed = inspectorElapsed(run, this.options.getElapsedNow());
			if (elapsed) {
				statusParts.push(theme.fg("muted", elapsed));
			}
		}
		lines.push(statusParts.join(" "));
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		if (status.detail && run.phase === "settled") {
			const detail = status.detail;
			const wrapped = wrapTextWithAnsi(theme.fg(statusColor(status.role), detail), width);
			for (const line of wrapped) {
				lines.push(truncateToWidth(line, width, theme.fg("dim", "…")));
			}
		}
		return lines;
	}

	private appendEvent(
		lines: string[],
		event: AiraChildEvent,
		pending: Map<string, PendingToolRow>,
		width: number,
	): void {
		switch (event.kind) {
			case "thinking": {
				lines.push(theme.fg("dim", "Thinking"));
				for (const line of wrapTextWithAnsi(theme.fg("thinkingText", event.text), width)) {
					lines.push(truncateToWidth(line, width, theme.fg("dim", "…")));
				}
				break;
			}
			case "text": {
				for (const line of wrapTextWithAnsi(theme.fg("text", event.text), width)) {
					lines.push(truncateToWidth(line, width, theme.fg("dim", "…")));
				}
				break;
			}
			case "tool_call": {
				const row = buildCompactRow(theme, {
					status: "running",
					label: event.name,
					targetText: event.args,
					targetIsPath: PATH_TARGET_TOOLS.has(event.name),
				});
				lines.push(truncateToWidth(row, width, theme.fg("dim", "…")));
				pending.set(event.toolCallId, { index: lines.length - 1, name: event.name, target: event.args });
				break;
			}
			case "tool_result": {
				const tool = pending.get(event.toolCallId);
				if (!tool) {
					break;
				}
				pending.delete(event.toolCallId);
				const row = buildCompactRow(theme, {
					status: event.isError ? "error" : "success",
					label: tool.name,
					targetText: tool.target,
					targetIsPath: PATH_TARGET_TOOLS.has(tool.name),
					excerpt: event.summary.length > 0 ? [event.summary] : undefined,
				});
				lines[tool.index] = truncateToWidth(row, width, theme.fg("dim", "…"));
				if (event.isError && event.summary.length > 0) {
					for (const line of wrapTextWithAnsi(theme.fg("error", event.summary), width)) {
						lines.push(truncateToWidth(line, width, theme.fg("dim", "…")));
					}
				}
				break;
			}
			case "permission": {
				const row = buildCompactRow(theme, {
					status: "warning",
					label: event.tool,
					targetText: "",
				});
				lines.push(truncateToWidth(row, width, theme.fg("dim", "…")));
				lines.push(
					truncateToWidth(theme.fg("warning", `permission: ${event.reason}`), width, theme.fg("dim", "…")),
				);
				break;
			}
			case "status": {
				const label =
					event.phase === "waiting-dependency" || event.phase === "waiting-capacity"
						? `${event.phase}`
						: event.status;
				lines.push(theme.fg("muted", `● ${label}`));
				break;
			}
			case "failure": {
				const label = `${event.category} — ${event.message}`;
				lines.push(theme.fg("red", `✕ ${label}`));
				break;
			}
			case "completion": {
				const color = event.status === "completed" ? "green" : "red";
				const label =
					event.status === "completed" ? `✓ completed — ${event.summary}` : `✕ failed — ${event.summary}`;
				const wrapped = wrapTextWithAnsi(theme.fg(color, label), width);
				for (const line of wrapped) {
					lines.push(truncateToWidth(line, width, theme.fg("dim", "…")));
				}
				break;
			}
		}
	}
}

function statusColor(
	role: "cyan" | "yellow" | "green" | "red" | "muted",
): "cyan" | "yellow" | "green" | "red" | "muted" {
	return role;
}
