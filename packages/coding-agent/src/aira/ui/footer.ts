/**
 * Aira UI — footer segment projections.
 *
 * The status rail is segment-based with explicit responsive priorities:
 *
 * - ALWAYS PRESERVE (required): mode, context usage, model.
 * - CRITICAL WHEN PRESENT (very late drop): pending interaction/permission,
 *   highest-priority current finding.
 * - ACTIVE WHEN RELEVANT (late drop): verification, goal, agents, browser,
 *   execution.
 * - OPPORTUNISTIC (early drop): LSP detail, permission mode, git delta,
 *   exact counts, branch detail.
 *
 * Lower `dropRank` disappears FIRST. Required segments are never dropped —
 * only compacted/truncated. Deterministic and pure; all values derive from
 * canonical snapshots.
 */

import type { AiraSessionState } from "../state.ts";
import type { WorkbenchFinding, WorkbenchFooterSegment, WorkbenchRole } from "./types.ts";

export const FOOTER_SEPARATOR = "│";

/** Compact token-count formatting (pure; shared by footer + context segment). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Drop ranks: lower disappears first. Infinity = never dropped. */
const DROP = {
	git: 1,
	permission: 2,
	lsp: 4,
	execution: 10,
	browser: 10,
	agents: 10,
	goal: 10,
	verification: 10,
	finding: 60,
	cwd: 40,
	interaction: 100,
	context: Number.POSITIVE_INFINITY,
	model: Number.POSITIVE_INFINITY,
	mode: Number.POSITIVE_INFINITY,
} as const;

/** Compact provider-language tag for LSP segments (deterministic short map). */
export function lspShortId(providerId: string): string {
	const known = new Map<string, string>([
		["typescript", "TS"],
		["tsgo", "TS"],
		["pyright", "PY"],
		["gopls", "GO"],
		["rust-analyzer", "RS"],
		["clangd", "CPP"],
		["biome", "BIOME"],
	]);
	const exact = known.get(providerId);
	if (exact) return exact;
	const short = providerId.slice(0, 2).toUpperCase();
	return short.length === 2 ? short : "LSP";
}

function modeSegment(state: AiraSessionState): WorkbenchFooterSegment {
	const glyph = state.mode === "build" ? "◈" : state.mode === "plan" ? "◇" : "◎";
	const label = state.mode === "build" ? "BUILD" : state.mode === "plan" ? "PLAN" : "REVIEW";
	return {
		id: "mode",
		text: `${glyph} ${label}`,
		role: "copper",
		dropRank: DROP.mode,
		required: true,
	};
}

function interactionSegment(state: AiraSessionState): WorkbenchFooterSegment | undefined {
	const interaction = state.interaction;
	if (!interaction?.pending || !interaction.question) return undefined;
	const question = interaction.question;
	const isPermission = question.type === "permission";
	const prompt = question.prompt.replace(/\s+/g, " ").trim();
	return {
		id: "interaction",
		text: `ASK ● ${prompt.length > 42 ? `${prompt.slice(0, 41)}…` : prompt}`,
		compact: "ASK ●",
		role: isPermission ? "purple" : "yellow",
		dropRank: DROP.interaction,
		required: true,
		maxWidth: 60,
	};
}

function findingSegment(finding: WorkbenchFinding | undefined): WorkbenchFooterSegment | undefined {
	if (!finding) return undefined;
	const code = finding.code ? `${finding.code} · ` : "";
	const role: WorkbenchRole =
		finding.severity === "error"
			? "red"
			: finding.severity === "wait"
				? "yellow"
				: finding.severity === "warning"
					? "yellow"
					: "muted";
	return {
		id: "finding",
		text: `${code}${finding.label}`,
		role,
		dropRank: DROP.finding,
		maxWidth: 60,
	};
}

function lspSegment(state: AiraSessionState): WorkbenchFooterSegment | undefined {
	const intelligence = state.intelligence;
	if (!intelligence || !intelligence.active) return undefined;
	const live = intelligence.liveCode;
	const provider = live.servers[0]?.id;
	const tag = provider ? lspShortId(provider) : (intelligence.languages[0]?.slice(0, 2).toUpperCase() ?? "LSP");
	const errors = intelligence.findings.errors;
	const warnings = intelligence.findings.warnings;
	const hasInfo = live.status !== "unavailable" || errors > 0 || warnings > 0;
	if (!hasInfo) return undefined;
	return {
		id: "lsp",
		text: `LSP ${tag}${errors > 0 ? ` ${errors}E` : ""}${warnings > 0 ? ` ${warnings}W` : ""}`,
		compact: `LSP ${errors > 0 ? `${errors}E` : warnings > 0 ? `${warnings}W` : tag}`,
		role: errors > 0 ? "red" : warnings > 0 ? "yellow" : "blue",
		dropRank: DROP.lsp,
	};
}

function verificationSegment(state: AiraSessionState): WorkbenchFooterSegment | undefined {
	const verification = state.verification;
	if (!verification || verification.status === "idle") return undefined;
	const status = verification.status;
	if (status === "passed") {
		return { id: "verification", text: "VERIFY ✓", role: "green", dropRank: DROP.verification, compact: "VERIFY ✓" };
	}
	if (status === "failed") {
		const count = verification.highestFinding ? 1 : 0;
		return {
			id: "verification",
			text: `VERIFY ✕${count}`,
			role: "red",
			dropRank: DROP.verification,
			compact: "VERIFY ✕",
		};
	}
	if (status === "inconclusive") {
		return { id: "verification", text: "VERIFY ?", role: "yellow", dropRank: DROP.verification, compact: "VERIFY ?" };
	}
	if (verification.stale && verification.currentResult) {
		return {
			id: "verification",
			text: "VERIFY stale",
			role: "yellow",
			dropRank: DROP.verification,
			compact: "VERIFY …",
		};
	}
	return { id: "verification", text: "VERIFY …", role: "yellow", dropRank: DROP.verification, compact: "VERIFY …" };
}

function browserSegment(state: AiraSessionState): WorkbenchFooterSegment | undefined {
	const browser = state.browser;
	if (!browser) return undefined;
	const relevant =
		browser.status === "active" ||
		browser.status === "degraded" ||
		browser.verification.status !== "none" ||
		browser.console.errors > 0 ||
		browser.network.failures > 0;
	if (!relevant) return undefined;
	if (browser.verification.status === "failed" || browser.console.errors > 0) {
		const count = browser.console.errors > 0 ? browser.console.errors : 1;
		return { id: "browser", text: `BROWSER ✕${count}`, role: "red", dropRank: DROP.browser, compact: "BROWSER ✕" };
	}
	if (browser.verification.status === "pending" || browser.status === "active") {
		return { id: "browser", text: "BROWSER ●", role: "cyan", dropRank: DROP.browser, compact: "BROWSER ●" };
	}
	return { id: "browser", text: "BROWSER", role: "muted", dropRank: DROP.browser };
}

function agentsSegment(state: AiraSessionState): WorkbenchFooterSegment | undefined {
	const orchestration = state.orchestration;
	if (!orchestration) return undefined;
	const running = orchestration.runningCount;
	const queued = orchestration.queuedCount;
	const total = running + queued;
	if (total === 0 && orchestration.children.length === 0) return undefined;
	return {
		id: "agents",
		text: `AGENTS ${total}`,
		compact: `A${total}`,
		role: running > 0 ? "cyan" : "muted",
		dropRank: DROP.agents,
	};
}

function goalSegment(state: AiraSessionState): WorkbenchFooterSegment | undefined {
	const goal = state.goal;
	if (!goal || goal.status === "idle") return undefined;
	if (goal.status === "completed") {
		return { id: "goal", text: "GOAL ✓", role: "green", dropRank: DROP.goal, compact: "GOAL ✓" };
	}
	const done = goal.tasks.completed;
	const total = goal.tasks.completed + goal.tasks.active;
	const tasksText = total > 0 ? ` ${done}/${total}` : "";
	const roundText = goal.round > 0 ? ` R${goal.round}` : "";
	const role: WorkbenchRole =
		goal.status === "error" || goal.status === "budget-limited" || goal.status === "cancelled"
			? "red"
			: goal.status === "waiting" || goal.status === "paused"
				? "yellow"
				: "yellow";
	return {
		id: "goal",
		text: `GOAL${roundText}${tasksText}`,
		compact: `GOAL${roundText}`,
		role,
		dropRank: DROP.goal,
	};
}

function executionSegment(state: AiraSessionState): WorkbenchFooterSegment | undefined {
	const execution = state.execution;
	if (!execution) return undefined;
	const running = execution.processes.filter((process) => process.status === "running").length;
	if (running > 0) {
		return {
			id: "execution",
			text: `RUN ${running}`,
			role: "cyan",
			dropRank: DROP.execution,
			compact: `RUN ${running}`,
		};
	}
	const failed = execution.recentResults.find((result) => !result.ok);
	if (failed && failed.status !== "cancelled") {
		return { id: "execution", text: "EXEC ✕", role: "red", dropRank: DROP.execution, compact: "EXEC ✕" };
	}
	if (execution.recentResults.length > 0) {
		return { id: "execution", text: "EXEC ✓", role: "green", dropRank: DROP.execution, compact: "EXEC ✓" };
	}
	return undefined;
}

function permissionSegment(state: AiraSessionState): WorkbenchFooterSegment | undefined {
	const permissions = state.permissions;
	if (!permissions) return undefined;
	const mode = permissions.enabled ? permissions.mode : "off";
	return {
		id: "permission",
		text: `PERM ${mode}`,
		role: "purple",
		dropRank: DROP.permission,
	};
}

function cwdSegment(cwd: string, branch: string | undefined): WorkbenchFooterSegment {
	const text = branch ? `${cwd} (${branch})` : cwd;
	const compact = branch ? `${cwd.split("/").pop() ?? cwd} (${branch})` : (cwd.split("/").pop() ?? cwd);
	return { id: "cwd", text, compact, role: "muted", dropRank: DROP.cwd };
}

function gitSegment(changeCount: number | undefined): WorkbenchFooterSegment | undefined {
	if (changeCount === undefined || changeCount <= 0) return undefined;
	return { id: "git", text: `Δ${changeCount}`, role: "muted", dropRank: DROP.git };
}

function contextSegment(context: {
	percent: string;
	window: number;
	autoCompact: boolean;
	over90: boolean;
	over70: boolean;
}): WorkbenchFooterSegment {
	const text = `${context.percent}%/${formatTokens(context.window)}${context.autoCompact ? " ·auto" : ""}`;
	return {
		id: "context",
		text,
		compact: `${context.percent}%`,
		role: context.over90 ? "red" : context.over70 ? "yellow" : "text",
		dropRank: DROP.context,
		required: true,
	};
}

function modelSegment(model: string, thinking: string | undefined): WorkbenchFooterSegment {
	return {
		id: "model",
		text: thinking ? `${model} · ${thinking}` : model,
		compact: model,
		role: "purple",
		dropRank: DROP.model,
		required: true,
	};
}

/** Build footer segments in display order (left groups then right groups). */
export function buildFooterSegments(input: {
	state: AiraSessionState;
	finding: WorkbenchFinding | undefined;
	cwd: string;
	branch: string | undefined;
	context: {
		percent: string;
		window: number;
		autoCompact: boolean;
		over90: boolean;
		over70: boolean;
	};
	modelId: string;
	thinkingLevel: string | undefined;
}): { left: WorkbenchFooterSegment[]; right: WorkbenchFooterSegment[] } {
	const { state, finding } = input;
	const left: WorkbenchFooterSegment[] = [
		modeSegment(state),
		...(interactionSegment(state) ? [interactionSegment(state)!] : []),
		...(findingSegment(finding) ? [findingSegment(finding)!] : []),
		...(lspSegment(state) ? [lspSegment(state)!] : []),
		...(verificationSegment(state) ? [verificationSegment(state)!] : []),
		...(browserSegment(state) ? [browserSegment(state)!] : []),
		...(agentsSegment(state) ? [agentsSegment(state)!] : []),
		...(goalSegment(state) ? [goalSegment(state)!] : []),
		...(executionSegment(state) ? [executionSegment(state)!] : []),
		...(permissionSegment(state) ? [permissionSegment(state)!] : []),
	];
	const right: WorkbenchFooterSegment[] = [
		cwdSegment(input.cwd, input.branch),
		...(gitSegment(state.intelligence?.repository.changeCount)
			? [gitSegment(state.intelligence?.repository.changeCount)!]
			: []),
		contextSegment(input.context),
		modelSegment(input.modelId, input.thinkingLevel),
	];
	return { left, right };
}
