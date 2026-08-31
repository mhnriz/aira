/**
 * Aira UI — highest-priority finding arbitration.
 *
 * Picks the SINGLE most useful current finding across canonical sources
 * (LSP/intelligence, verifier, browser, execution, orchestration, goal,
 * interaction). All severity and status come from the source snapshots —
 * the UI never invents severity. Deterministic: a fixed source order within
 * explicit priority classes, first-match-wins.
 */

import type { AiraSessionState } from "../state.ts";
import type { WorkbenchFinding, WorkbenchPriority } from "./types.ts";

const SOURCE_ORDER = ["interaction", "goal", "verifier", "lsp", "browser", "execution", "agents"] as const;

/** Bound a label to a footer-safe length. */
function bound(text: string | undefined, max: number, fallback = ""): string {
	if (!text) return fallback;
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, Math.max(0, max - 1))}…` : collapsed;
}

export interface FindingCandidate {
	readonly severity: WorkbenchFinding["severity"];
	readonly source: string;
	readonly priority: WorkbenchPriority;
	readonly label: string;
	readonly detail?: string;
	readonly code?: string;
}

/** Arbitrate the single highest-priority finding from canonical state. */
export function arbitrateCurrentFinding(state: AiraSessionState | undefined): WorkbenchFinding | undefined {
	if (!state) return undefined;
	const candidates: FindingCandidate[] = [];

	// ---- P0 · interaction: a pending question/permission outranks everything.
	const interaction = state.interaction;
	if (interaction?.pending && interaction.question) {
		const question = interaction.question;
		const type = question.type === "permission" ? "authorization" : "question";
		candidates.push({
			severity: "wait",
			source: question.type === "permission" ? "permission" : "ask",
			priority: 0,
			label: `${type}: ${bound(question.prompt, 60)}`,
			detail: `${type} · waiting ${Math.max(1, Math.round(question.durationMs / 1000))}s · ${
				question.choicesCount > 0
					? `${question.choicesCount} choice(s)`
					: question.freeform
						? "freeform"
						: "no choices"
			}`,
		});
	}

	// ---- P0 · goal genuinely waiting for the user.
	const goal = state.goal;
	if (goal && goal.status === "waiting" && goal.needsUserInput) {
		candidates.push({
			severity: "wait",
			source: "goal",
			priority: 0,
			label: bound(goal.waiting?.ask ?? goal.waiting?.detail ?? "user decision required", 60),
			detail: `goal ${goal.round}/${goal.maxRounds} · ${goal.waiting?.reason ?? "input-required"}`,
		});
	}

	// ---- P0 · verifier: FAIL and INCONCLUSIVE are prominent.
	const verification = state.verification;
	if (verification) {
		const result = verification.currentResult;
		const fresh = !verification.stale;
		if (result?.verdict === "fail") {
			candidates.push({
				severity: "error",
				source: "verifier",
				priority: 0,
				label: bound(
					verification.highestFinding?.message ??
						result.summary ??
						`verification failed (${result.requirements.filter((r) => r.status === "verified").length}/${result.requirements.length} requirements)`,
					60,
				),
				detail: `${fresh ? "fresh" : "stale"} · ${result.requirements.filter((r) => r.status === "verified").length}/${result.requirements.length} requirements`,
				code: `VERIFY`,
			});
		} else if (result?.verdict === "inconclusive") {
			candidates.push({
				severity: "warning",
				source: "verifier",
				priority: 0,
				label: bound(verification.lastError ?? result.summary ?? "verification inconclusive", 60),
				detail: `inconclusive · ${fresh ? "current" : "stale"}`,
				code: "VERIFY",
			});
		} else if (verification.stale && result) {
			// A stale PASS/FAIL must not present as current truth.
			candidates.push({
				severity: "warning",
				source: "verifier",
				priority: 1,
				label: `verification result is stale (${result.verdict})`,
				detail: bound(result.staleReason, 80),
				code: "VERIFY",
			});
		}
	}

	// ---- P0/P2 · intelligence (LSP) findings, fresh errors first.
	const intelligence = state.intelligence;
	if (intelligence?.findings.top) {
		const top = intelligence.findings.top[0];
		if (top && top.severity === "error" && top.freshness !== "stale") {
			const code = top.code !== undefined ? String(top.code) : undefined;
			candidates.push({
				severity: "error",
				source: "lsp",
				priority: 0,
				label: bound(top.message, 60),
				detail: `${top.path ?? "unknown path"}${top.line ? `:${top.line}` : ""} · ${top.freshness}`,
				...(code ? { code } : {}),
			});
		} else if (top && top.severity !== "error") {
			candidates.push({
				severity: "warning",
				source: "lsp",
				priority: 2,
				label: bound(top.message, 60),
				detail: `${top.path ?? "unknown path"}${top.line ? `:${top.line}` : ""} · ${top.freshness}`,
				...(top.code !== undefined ? { code: String(top.code) } : {}),
			});
		}
	}

	// ---- P1 · browser: failed check or console errors rise above idle state.
	const browser = state.browser;
	if (browser) {
		const check = browser.verification;
		if (check.status === "failed") {
			candidates.push({
				severity: "error",
				source: "browser",
				priority: 1,
				label: bound(check.finding?.message ?? "browser check failed", 60),
				detail: `browser check · ${browser.console.errors}E ${browser.console.warnings}W · ${browser.network.failures} failed request(s)`,
				code: "BROWSER",
			});
		} else if (browser.console.errors > 0) {
			candidates.push({
				severity: "warning",
				source: "browser",
				priority: 1,
				label: bound(browser.console.topFinding?.message ?? `${browser.console.errors} console error(s)`, 60),
				detail: `${browser.console.errors}E ${browser.console.warnings}W on ${browser.activeTab?.url ?? "active page"}`,
				code: "BROWSER",
			});
		}
	}

	// ---- P1 · execution: recent failed results are blocking evidence.
	const execution = state.execution;
	if (execution?.recentResults) {
		const failed = execution.recentResults.find((result) => !result.ok);
		if (failed && failed.status !== "cancelled") {
			candidates.push({
				severity: "error",
				source: "execution",
				priority: 1,
				label: bound(failed.reason ?? `command failed (${failed.status})`, 60),
				detail: bound(failed.command, 80),
				code: "EXEC",
			});
		}
	}

	// ---- P1 · orchestration: bounded failure telemetry.
	const orchestration = state.orchestration;
	if (orchestration?.failures && orchestration.failures.length > 0) {
		const failure = orchestration.failures[0]!;
		candidates.push({
			severity: failure.retryable ? "warning" : "error",
			source: "agents",
			priority: 1,
			label: bound(failure.message, 60),
			detail: `${failure.role} · ${failure.category}`,
			code: "AGENT",
		});
	}

	// ---- Arbitrate: highest priority class wins; fixed source order within.
	candidates.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return (
			SOURCE_ORDER.indexOf(a.source as (typeof SOURCE_ORDER)[number]) -
			SOURCE_ORDER.indexOf(b.source as (typeof SOURCE_ORDER)[number])
		);
	});
	const chosen = candidates[0];
	if (!chosen) return undefined;
	return {
		severity: chosen.severity,
		source: chosen.source,
		...(chosen.code ? { code: chosen.code } : {}),
		label: chosen.label,
		...(chosen.detail ? { detail: chosen.detail } : {}),
		priority: chosen.priority,
	};
}

/** Compact single-line finding label for the footer (e.g. "TS2339 · msg"). */
export function formatFindingLabel(finding: WorkbenchFinding): string {
	const code = finding.code ? `${finding.code} · ` : "";
	return `${code}${finding.label}`;
}
