/**
 * Aira core — native `/status` command.
 *
 * Phase 1: minimal proof that host → lifecycle bridge → canonical state →
 * command surface works end to end. Phase 2 adds the Aira product identity and
 * canonical home so `/status` is the first place the product surfaces who it is
 * and where it lives. Deliberately not a dashboard.
 *
 * The report is built from canonical Aira state plus host-level identity;
 * formatting is plain text so the TUI (and future surfaces) can render it in
 * their own style.
 */
import { formatAiraVersion } from "../meta.ts";
import { displayPathUnderHome, getAiraHome } from "../paths.ts";
import { summarizeAiraProject } from "../project/profile.ts";
import type { AiraSessionState } from "../state.ts";

export interface AiraStatusReport {
	/** False when no canonical state exists for the session (wiring bug). */
	available: boolean;
	/** Product identity line, e.g. "Aira 0.1.0 (Pi base 0.84.3)". */
	product: string;
	/** Canonical home, e.g. "~/.aira". */
	home: string;
	sessionId?: string;
	runtime?: string;
	mode?: string;
	project?: string;
	capabilities?: string;
}

export function buildAiraStatusReport(state: AiraSessionState | undefined): AiraStatusReport {
	const identity = {
		product: formatAiraVersion(),
		home: displayPathUnderHome(getAiraHome()),
	};
	if (!state) {
		return { available: false, ...identity };
	}
	return {
		available: true,
		...identity,
		sessionId: state.sessionId,
		runtime: state.runtime,
		mode: state.mode,
		project: summarizeAiraProject(state.project),
		capabilities: state.capabilities.length === 0 ? "none" : state.capabilities.join(", "),
	};
}

export function formatAiraStatusReport(report: AiraStatusReport): string {
	const lines = [report.product, `home: ${report.home}`];
	if (!report.available) {
		lines.push("state: unavailable");
		return lines.join("\n");
	}
	lines.push(
		`runtime: ${report.runtime}`,
		`session: ${report.sessionId}`,
		`mode: ${report.mode}`,
		`project: ${report.project}`,
		`capabilities: ${report.capabilities}`,
	);
	return lines.join("\n");
}
