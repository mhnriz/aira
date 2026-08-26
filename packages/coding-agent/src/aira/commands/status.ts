/**
 * Aira core — native `/status` command.
 *
 * Phase 1: a minimal proof that host → lifecycle bridge → canonical state →
 * command surface works end to end. Deliberately not a dashboard.
 *
 * The report is built from canonical Aira state only; formatting is plain text
 * so the TUI (and future surfaces) can render it in their own style.
 */
import type { AiraSessionState } from "../state.ts";

export interface AiraStatusReport {
	/** False when no canonical state exists for the session (wiring bug). */
	available: boolean;
	sessionId?: string;
	runtime?: string;
	mode?: string;
	project?: string;
	capabilities?: string;
}

export function buildAiraStatusReport(state: AiraSessionState | undefined): AiraStatusReport {
	if (!state) {
		return { available: false };
	}
	return {
		available: true,
		sessionId: state.sessionId,
		runtime: state.runtime,
		mode: state.mode,
		project: state.project,
		capabilities: state.capabilities.length === 0 ? "none" : state.capabilities.join(", "),
	};
}

export function formatAiraStatusReport(report: AiraStatusReport): string {
	if (!report.available) {
		return "Aira\nstate: unavailable";
	}
	return [
		"Aira",
		`runtime: ${report.runtime}`,
		`session: ${report.sessionId}`,
		`mode: ${report.mode}`,
		`project: ${report.project}`,
		`capabilities: ${report.capabilities}`,
	].join("\n");
}
