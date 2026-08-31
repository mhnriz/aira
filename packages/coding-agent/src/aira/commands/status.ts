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

import type { AiraBrowserStatus } from "../browser/status.ts";
import { summarizeAiraGoal } from "../goal/status.ts";
import { formatAiraVersion } from "../meta.ts";
import { summarizeAiraOrchestration } from "../orchestration/status.ts";
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
	/** Compact browser line from the canonical snapshot (Phase 7). */
	browser?: string;
	/** Compact verification line from the canonical snapshot (Phase 8). */
	verification?: string;
	/** Compact orchestration line from the canonical snapshot (Phase 9). */
	orchestration?: string;
	/** Compact goal line from the canonical snapshot (Phase 10). */
	goal?: string;
	/** Compact permission line from the canonical snapshot (Phase 11). */
	permissions?: string;
	/** Compact interaction line from the canonical snapshot (Phase 11). */
	interaction?: string;
	/** Compact task line from the canonical snapshot (Phase 11). */
	tasks?: string;
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
		browser: summarizeAiraBrowser(state.browser),
		verification: summarizeAiraVerification(state.verification),
		orchestration: summarizeAiraOrchestration(state.orchestration),
		goal: summarizeAiraGoal(state.goal),
		permissions: summarizeAiraPermissions(state.permissions),
		interaction: summarizeAiraInteraction(state.interaction),
		tasks: summarizeAiraTasks(state.tasks),
	};
}

/** Compact one-line verification summary for /status (restrained). */
function summarizeAiraVerification(verification: AiraSessionState["verification"]): string | undefined {
	if (!verification) {
		return undefined;
	}
	const result = verification.currentResult;
	const verdict = result ? String(result.verdict) : verification.status;
	const freshness = result?.stale ? " · stale" : "";
	return `${verdict}${freshness}`;
}

/** Compact one-line browser summary for /status ("idle", "active (url)"). */
function summarizeAiraBrowser(browser: AiraBrowserStatus | undefined): string | undefined {
	if (!browser) return undefined;
	if (browser.status === "active") {
		const url = browser.activeTab?.url || browser.devProcess?.url;
		return `active${url ? ` (${url})` : ""}`;
	}
	return browser.status;
}

/** Compact one-line permission summary for /status (restrained). */
function summarizeAiraPermissions(permissions: AiraSessionState["permissions"]): string | undefined {
	if (!permissions) {
		return undefined;
	}
	return permissions.enabled ? permissions.mode : "disabled";
}

/** Compact one-line interaction summary for /status (only when pending). */
function summarizeAiraInteraction(interaction: AiraSessionState["interaction"]): string | undefined {
	if (!interaction || !interaction.pending) {
		return undefined;
	}
	const question = interaction.question;
	if (!question) {
		return "question pending";
	}
	return `${question.type} question pending (${question.choicesCount} choices · ${Math.round(question.durationMs / 1000)}s)`;
}

/** Compact one-line task summary for /status (restrained). */
function summarizeAiraTasks(tasks: AiraSessionState["tasks"]): string | undefined {
	if (!tasks) {
		return undefined;
	}
	return tasks.enabled ? tasks.summary : "disabled";
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
	if (report.browser) {
		lines.push(`browser: ${report.browser}`);
	}
	if (report.verification) {
		lines.push(`verification: ${report.verification}`);
	}
	if (report.orchestration) {
		lines.push(`orchestration: ${report.orchestration}`);
	}
	if (report.goal) {
		lines.push(`goal: ${report.goal}`);
	}
	if (report.permissions) {
		lines.push(`permissions: ${report.permissions}`);
	}
	if (report.interaction) {
		lines.push(`interaction: ${report.interaction}`);
	}
	if (report.tasks) {
		lines.push(`tasks: ${report.tasks}`);
	}
	return lines.join("\n");
}
