/**
 * Aira core — native `/mode` command.
 *
 * `/mode` is the explicit control for the native BUILD / PLAN / REVIEW cycle
 * (Shift+Tab is the shortcut; this is the discoverable slash form). The report
 * is built from canonical Aira state; formatting is plain text so the TUI (and
 * future surfaces) can render it in their own style.
 *
 *   /mode                 show current mode + hint
 *   /mode cycle           advance BUILD → PLAN → REVIEW → BUILD
 *   /mode <build|plan|review>   set the mode explicitly
 */
import { airaModeLabel, NEXT_AIRA_MODE } from "../modes.ts";
import type { AiraMode, AiraSessionState } from "../state.ts";

export interface AiraModeReport {
	/** False when no canonical state exists for the session (wiring bug). */
	available: boolean;
	/** The current mode, when available. */
	mode?: AiraMode;
	/** Uppercase display label, e.g. "BUILD". */
	label?: string;
	/** True when the current mode is read-only at the host/tool-policy level. */
	readOnly?: boolean;
	/** The next mode in the cycle. */
	next?: AiraMode;
}

/** Build the mode report from canonical state. */
export function buildAiraModeReport(state: AiraSessionState | undefined): AiraModeReport {
	if (!state) {
		return { available: false };
	}
	const mode = state.mode;
	return {
		available: true,
		mode,
		label: airaModeLabel(mode),
		readOnly: mode === "plan",
		next: NEXT_AIRA_MODE[mode],
	};
}

export function formatAiraModeReport(report: AiraModeReport): string {
	if (!report.available) {
		return "mode: unavailable";
	}
	return [
		`mode: ${report.label}${report.readOnly ? " (read-only)" : ""}`,
		`next: ${airaModeLabel(report.next!)}`,
		"Shift+Tab cycles BUILD → PLAN → REVIEW",
	].join("\n");
}

/** Parse the `/mode` argument into a mode, "cycle", or undefined. */
export function parseAiraModeArg(arg: string | undefined): AiraMode | "cycle" | undefined {
	if (arg === undefined || arg === "") return undefined;
	if (arg === "cycle" || arg === "next") return "cycle";
	if (arg === "build" || arg === "plan" || arg === "review") return arg;
	return undefined;
}
