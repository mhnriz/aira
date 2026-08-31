/**
 * Aira UI — Workbench panel projections.
 *
 * Each panel is a pure, bounded derivation from ONE canonical snapshot (see
 * module doc comments per builder). Bounds keep the sidebar scannable; the
 * projection never queries internals, runs git, or touches providers.
 */

import type { AiraSessionState } from "../state.ts";
import type {
	WorkbenchFileRow,
	WorkbenchFinding,
	WorkbenchPanel,
	WorkbenchPriority,
	WorkbenchRow,
	WorkbenchSymbolRow,
} from "./types.ts";

/** Maximum rows rendered per panel (bounded sidebar). */
export const WORKBENCH_PANEL_ROW_LIMIT = 8;
export const WORKBENCH_TASK_ROWS = 6;
export const WORKBENCH_SYMBOL_ROWS = 8;

function elapsed(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 === 0 ? "" : `${s % 60}s`}`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function statusLetter(status: WorkbenchFileRow["status"]): {
	letter: string;
	role: "green" | "yellow" | "red" | "muted";
} {
	switch (status) {
		case "added":
			return { letter: "A", role: "green" };
		case "modified":
			return { letter: "M", role: "yellow" };
		case "deleted":
			return { letter: "D", role: "red" };
		case "renamed":
			return { letter: "R", role: "yellow" };
		case "untracked":
			return { letter: "?", role: "muted" };
	}
}

// ---------------------------------------------------------------------------
// P0 — interaction (pending question / permission request)
// ---------------------------------------------------------------------------

export function interactionPanel(state: AiraSessionState): WorkbenchPanel | undefined {
	const interaction = state.interaction;
	if (!interaction?.pending || !interaction.question) return undefined;
	const question = interaction.question;
	const isPermission = question.type === "permission";
	const rows: WorkbenchRow[] = [
		{
			label: "Prompt",
			value: question.prompt,
			role: isPermission ? "purple" : "yellow",
		},
	];
	if (question.choicesCount > 0) {
		rows.push({ label: "Choices", value: `${question.choicesCount}`, role: "muted" });
	} else if (question.freeform) {
		rows.push({ label: "Input", value: "freeform", role: "muted" });
	}
	return {
		id: "interaction",
		title: isPermission ? "Authorization" : "Question",
		priority: 0,
		rows,
		hint: `waiting ${Math.max(1, Math.round(question.durationMs / 1000))}s · ${isPermission ? "permission" : "semantic"}`,
	};
}

// ---------------------------------------------------------------------------
// P0/P2 — current finding
// ---------------------------------------------------------------------------

export function findingPanel(finding: WorkbenchFinding | undefined): WorkbenchPanel | undefined {
	if (!finding) return undefined;
	const role =
		finding.severity === "error"
			? "red"
			: finding.severity === "wait"
				? "yellow"
				: finding.severity === "warning"
					? "yellow"
					: "muted";
	const code = finding.code ? `${finding.code} · ` : "";
	return {
		id: "finding",
		title: "Current Finding",
		priority: finding.priority,
		rows: [{ value: `${code}${finding.label}`, role }],
		hint: finding.detail ? `${finding.detail} · ${finding.source}` : finding.source,
	};
}

// ---------------------------------------------------------------------------
// P0/P1/P2 — verification
// ---------------------------------------------------------------------------

export function verificationPanel(state: AiraSessionState): WorkbenchPanel | undefined {
	const verification = state.verification;
	if (!verification || verification.status === "idle") return undefined;
	const result = verification.currentResult;
	const status = verification.status;
	const running = status === "preparing" || status === "running";
	const unverified = status === "failed" || status === "inconclusive";
	const priority: WorkbenchPriority = unverified ? 0 : running ? 1 : verification.stale ? 1 : 2;
	const rows: WorkbenchRow[] = [];
	const verdictText = result
		? `${result.verdict.toUpperCase()}${verification.stale ? " · stale" : " · fresh"}`
		: status.toUpperCase();
	const verdictRole = unverified ? "red" : running ? "yellow" : "green";
	rows.push({ label: "Verdict", value: verdictText, role: verdictRole });
	if (verification.requirementsTotal > 0) {
		rows.push({
			label: "Requirements",
			value: `${verification.requirementsVerified} / ${verification.requirementsTotal}`,
			role: verification.requirementsVerified === verification.requirementsTotal ? "green" : "yellow",
		});
	}
	if (verification.highestFinding) {
		rows.push({
			label: "Finding",
			value: verification.highestFinding.message,
			role: verification.highestFinding.severity === "blocking" ? "red" : "yellow",
		});
	}
	if (verification.missingEvidence.length > 0) {
		rows.push({ label: "Missing", value: verification.missingEvidence.slice(0, 2).join("; "), role: "muted" });
	}
	if (verification.lastError) {
		rows.push({ label: "Error", value: verification.lastError, role: "yellow" });
	}
	const satisfied =
		verification.requirementsTotal === 0 ? 0 : verification.requirementsVerified / verification.requirementsTotal;
	const progress =
		verification.requirementsTotal > 0
			? { value: satisfied, role: unverified ? ("red" as const) : ("green" as const) }
			: undefined;
	return {
		id: "verification",
		title: "Verification",
		priority,
		rows: rows.slice(0, WORKBENCH_PANEL_ROW_LIMIT),
		...(progress ? { progress } : {}),
	};
}

// ---------------------------------------------------------------------------
// P0/P1/P2 — goal
// ---------------------------------------------------------------------------

export function goalPanel(state: AiraSessionState): WorkbenchPanel | undefined {
	const goal = state.goal;
	if (!goal || goal.status === "idle") return undefined;
	const waiting = goal.status === "waiting" && goal.needsUserInput;
	const running = goal.status === "active" || goal.status === "repairing" || goal.status === "verifying";
	const priority: WorkbenchPriority = waiting ? 0 : running ? 1 : 2;
	const stateRole =
		goal.status === "completed"
			? "green"
			: running
				? "yellow"
				: waiting
					? "purple"
					: goal.status === "error" || goal.status === "budget-limited"
						? "red"
						: "muted";
	const rows: WorkbenchRow[] = [
		{
			label: "State",
			value: goal.status === "budget-limited" ? "budget-limited" : goal.status,
			role: stateRole,
		},
	];
	if (goal.objective) {
		rows.push({ label: "Objective", value: goal.objective, role: "text" });
	}
	const tasksTotal = goal.tasks.completed + goal.tasks.active;
	if (tasksTotal > 0 || goal.round > 0) {
		rows.push({
			label: "Tasks",
			value: `${goal.tasks.completed} / ${tasksTotal}${goal.tasks.active > 0 ? ` · ${goal.tasks.active} active` : ""}`,
			role: "muted",
		});
	}
	if (goal.usage.remainingTokens !== undefined) {
		rows.push({
			label: "Budget",
			value: `${goal.usage.consumedTokens ?? "?"}k used · ${goal.usage.remainingTokens}k left`,
			role: "muted",
		});
	}
	if (goal.waiting?.detail) {
		rows.push({ label: "Waiting", value: goal.waiting.detail, role: "purple" });
	}
	if (goal.verification.verdict && goal.verification.verdict !== "pass") {
		rows.push({
			label: "Verify",
			value: goal.verification.verdict,
			role: goal.verification.verdict === "fail" ? "red" : "yellow",
		});
	}
	if (goal.lastEvent) {
		rows.push({ label: "Event", value: goal.lastEvent, role: "muted" });
	}
	const progressTarget = goal.maxRounds > 0 ? goal.round / goal.maxRounds : 0;
	const progressRole: "green" | "red" | "yellow" | "muted" = stateRole === "purple" ? "yellow" : stateRole;
	return {
		id: "goal",
		title: "Goal",
		priority,
		rows: rows.slice(0, WORKBENCH_PANEL_ROW_LIMIT),
		progress: { value: Math.min(1, progressTarget), role: progressRole },
	};
}

// ---------------------------------------------------------------------------
// P1/P2 — tasks & agents
// ---------------------------------------------------------------------------

export function tasksPanel(state: AiraSessionState): WorkbenchPanel | undefined {
	const tasks = state.tasks;
	const orchestration = state.orchestration;
	const hasTasks = (tasks?.total ?? 0) > 0;
	const running = (orchestration?.runningCount ?? 0) > 0;
	const queued = (orchestration?.queuedCount ?? 0) > 0;
	const active = running || queued || (tasks?.active ?? 0) > 0;
	if (!hasTasks && !active) return undefined;
	const priority: WorkbenchPriority = active ? 1 : 2;
	const rows: WorkbenchRow[] = [];

	for (const task of (tasks?.rows ?? []).slice(0, WORKBENCH_TASK_ROWS)) {
		const glyph =
			task.status === "completed"
				? "✓"
				: task.status === "active"
					? "●"
					: task.status === "blocked"
						? "○"
						: task.status === "failed"
							? "✕"
							: "○";
		const role =
			task.status === "completed"
				? "green"
				: task.status === "active"
					? "cyan"
					: task.status === "blocked"
						? "yellow"
						: task.status === "failed"
							? "red"
							: "muted";
		const detailParts: string[] = [];
		if (task.source === "child" && task.childRole) detailParts.push(task.childRole);
		if (task.status === "blocked") detailParts.push(`blocked by ${task.dependsOn.length} dep(s)`);
		if (task.detail) detailParts.push(task.detail);
		rows.push({
			key: task.id,
			value: `${glyph} ${task.title}`,
			role,
			detail: detailParts.length > 0 ? detailParts.join(" · ") : undefined,
		});
	}

	// Agent rows (bounded; never transcripts).
	for (const child of (orchestration?.children ?? []).slice(0, 4)) {
		if (child.status !== "running" && child.status !== "pending") continue;
		const glyph = child.status === "running" ? "●" : "○";
		rows.push({
			key: child.id,
			value: `${glyph} ${child.role} · ${child.task}`,
			role: "cyan",
			trailing: elapsed(child.elapsedMs),
			trailingRole: "muted",
		});
	}

	const activeAgents = (running ? 1 : 0) + (queued ? 1 : 0);
	return {
		id: "tasks",
		title: "Tasks & Agents",
		priority,
		rows: rows.slice(0, WORKBENCH_PANEL_ROW_LIMIT),
		hint: activeAgents > 0 ? `${activeAgents} active` : `${tasks?.completed ?? 0} done`,
	};
}

// ---------------------------------------------------------------------------
// P1/P3 — execution
// ---------------------------------------------------------------------------

function executionRelevant(state: AiraSessionState): boolean {
	const execution = state.execution;
	if (!execution) return false;
	if (execution.processes.some((p) => p.status === "running")) return true;
	return execution.recentResults.length > 0;
}

export function executionPanel(state: AiraSessionState): WorkbenchPanel | undefined {
	const execution = state.execution;
	if (!execution || !executionRelevant(state)) return undefined;
	const running = execution.processes.filter((p) => p.status === "running");
	const priority: WorkbenchPriority = running.length > 0 ? 1 : 2;
	const rows: WorkbenchRow[] = [];
	for (const process of running.slice(0, 4)) {
		const purpose = process.purpose === "run" ? "run" : process.purpose;
		rows.push({
			key: process.id,
			value: `${purpose} · ${process.command}`,
			role: "cyan",
			trailing: elapsed(process.startedAt ? Date.now() - process.startedAt : undefined),
			trailingRole: "muted",
		});
	}
	for (const result of execution.recentResults.slice(0, 4)) {
		const glyph = result.ok ? "✓" : "✕";
		rows.push({
			key: result.processId ?? result.command,
			value: `${glyph} ${result.command}`,
			role: result.ok ? "green" : "red",
			trailing: `${Math.round(result.durationMs / 1000)}s`,
			trailingRole: "muted",
			detail: result.reason,
		});
	}
	return {
		id: "execution",
		title: "Execution",
		priority,
		rows: rows.slice(0, WORKBENCH_PANEL_ROW_LIMIT),
		hint: running.length > 0 ? `${running.length} running` : "recent",
	};
}

// ---------------------------------------------------------------------------
// P1/P3 — browser
// ---------------------------------------------------------------------------

export function browserPanel(state: AiraSessionState): WorkbenchPanel | undefined {
	const browser = state.browser;
	if (!browser) return undefined;
	const relevant =
		browser.status === "active" ||
		browser.status === "degraded" ||
		browser.tabs.length > 0 ||
		browser.verification.status !== "none" ||
		browser.console.errors > 0 ||
		browser.network.failures > 0;
	if (!relevant) return undefined;
	const active = browser.status === "active";
	const priority: WorkbenchPriority =
		browser.verification.status === "pending" || browser.verification.status === "failed" ? 1 : active ? 1 : 3;
	const rows: WorkbenchRow[] = [
		{
			label: "Status",
			value: `${browser.status} · ${browser.availability}`,
			role: browser.status === "degraded" ? "red" : active ? "cyan" : "muted",
		},
	];
	if (browser.activeTab) {
		rows.push({ label: "Page", value: browser.activeTab.url || "(blank)", role: "text" });
	}
	rows.push({
		label: "Console",
		value: `${browser.console.errors}E ${browser.console.warnings}W`,
		role: browser.console.errors > 0 ? "red" : "muted",
	});
	rows.push({
		label: "Network",
		value: browser.network.failures === 0 ? "clean" : `${browser.network.failures} failed`,
		role: browser.network.failures > 0 ? "red" : "green",
	});
	const check = browser.verification;
	if (check.status !== "none") {
		rows.push({
			label: "Check",
			value:
				check.status === "pending"
					? "checking"
					: `${check.status}${check.finding ? ` · ${check.finding.message}` : ""}`,
			role: check.status === "failed" ? "red" : check.status === "pending" ? "yellow" : "green",
		});
	}
	if (browser.observation.summary) {
		rows.push({ label: "View", value: browser.observation.summary, role: "muted" });
	}
	if (browser.devProcess) {
		rows.push({ label: "Dev", value: `${browser.devProcess.id} (${browser.devProcess.status})`, role: "muted" });
	}
	return {
		id: "browser",
		title: "Browser",
		priority,
		rows: rows.slice(0, WORKBENCH_PANEL_ROW_LIMIT),
	};
}

// ---------------------------------------------------------------------------
// P2 — working set / relevant symbols / changeset / intelligence
// ---------------------------------------------------------------------------

export function workingSetPanel(files: readonly WorkbenchFileRow[]): WorkbenchPanel | undefined {
	if (files.length === 0) return undefined;
	const rows: WorkbenchRow[] = files.slice(0, WORKBENCH_PANEL_ROW_LIMIT).map((file) => {
		const letter = statusLetter(file.status);
		const delta = file.added > 0 || file.deleted > 0 ? `+${file.added} -${file.deleted}` : undefined;
		return {
			key: file.path,
			value: `${letter.letter} ${file.path}`,
			role: letter.role,
			trailing: delta,
			trailingRole: "muted",
		};
	});
	return {
		id: "working-set",
		title: "Working Set",
		priority: 2,
		rows,
	};
}

export function symbolsPanel(symbols: readonly WorkbenchSymbolRow[]): WorkbenchPanel | undefined {
	if (symbols.length === 0) return undefined;
	const rows: WorkbenchRow[] = symbols.slice(0, WORKBENCH_SYMBOL_ROWS).map((symbol) => ({
		key: `${symbol.path}:${symbol.name}`,
		value: `${symbol.name}()`,
		role: "blue",
		trailing: `${symbol.kind} · ${symbol.path}${symbol.line > 0 ? `:${symbol.line}` : ""}`,
		trailingRole: "muted",
	}));
	return {
		id: "symbols",
		title: "Relevant Symbols",
		priority: 2,
		rows,
	};
}

export function changesetPanel(files: readonly WorkbenchFileRow[]): WorkbenchPanel | undefined {
	if (files.length === 0) return undefined;
	let added = 0;
	let deleted = 0;
	for (const file of files) {
		added += file.added;
		deleted += file.deleted;
	}
	const rows: WorkbenchRow[] = [
		{
			label: "Summary",
			value: `+${added} -${deleted} · ${files.length} file${files.length === 1 ? "" : "s"}`,
			role: "text",
		},
	];
	for (const file of files.slice(0, 4)) {
		const delta = file.added > 0 || file.deleted > 0 ? `+${file.added} -${file.deleted}` : "new";
		rows.push({
			key: file.path,
			label: " ",
			value: file.path,
			role: "muted",
			trailing: delta,
			trailingRole: file.status === "deleted" ? "red" : file.status === "added" ? "green" : "muted",
		});
	}
	return {
		id: "changeset",
		title: "Changeset",
		priority: 2,
		rows,
		mediumCap: 3,
	};
}

export function intelligencePanel(state: AiraSessionState): WorkbenchPanel | undefined {
	const intelligence = state.intelligence;
	if (!intelligence) return undefined;
	const rows: WorkbenchRow[] = [];
	const repo = intelligence.repository;
	const live = intelligence.liveCode;
	rows.push({
		label: "Repo",
		value:
			repo.changeCount !== undefined && repo.changesAvailable
				? `${repo.status} · ${repo.filesIndexed} files · ${repo.changeCount} changed`
				: `${repo.status} · ${repo.filesIndexed} files`,
		role: intelligence.degraded ? "red" : "green",
	});
	const serverCount = live.servers.filter((server) => server.available).length;
	rows.push({
		label: "LSP",
		value:
			live.status === "unavailable"
				? "unavailable"
				: `${live.status}${serverCount > 0 ? ` · ${serverCount} server(s)` : ""}`,
		role:
			live.status === "ready"
				? "green"
				: live.status === "idle"
					? "yellow"
					: live.status === "degraded"
						? "red"
						: "muted",
	});
	const findings = intelligence.findings;
	if (findings.total > 0) {
		rows.push({
			label: "Diagnostics",
			value: `${findings.errors}E ${findings.warnings}W${findings.stale > 0 ? ` · ${findings.stale} stale` : ""}`,
			role: findings.errors > 0 ? "red" : findings.warnings > 0 ? "yellow" : "muted",
		});
	}
	return {
		id: "intelligence",
		title: "Intelligence",
		priority: 2,
		rows,
	};
}

// ---------------------------------------------------------------------------
// P3 — control / permissions
// ---------------------------------------------------------------------------

export function controlPanel(state: AiraSessionState): WorkbenchPanel | undefined {
	const permissions = state.permissions;
	if (!permissions) return undefined;
	const rows: WorkbenchRow[] = [
		{
			label: "Permission",
			value: permissions.enabled ? permissions.mode : "off",
			role: "purple",
		},
	];
	rows.push({
		label: "Rules",
		value: `${permissions.persistentRules} persistent · ${permissions.sessionRules} session`,
		role: "muted",
	});
	if (permissions.onceApprovals > 0) {
		rows.push({ label: "Approvals", value: `${permissions.onceApprovals} once`, role: "muted" });
	}
	rows.push({
		label: "Store",
		value: permissions.store.status,
		role: permissions.store.status === "failed" ? "red" : "muted",
	});
	return {
		id: "control",
		title: "Control",
		priority: 3,
		rows,
		mediumHidden: true,
	};
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------
const PANEL_ORDER: readonly string[] = [
	"interaction",
	"finding",
	"verification",
	"goal",
	"tasks",
	"execution",
	"browser",
	"working-set",
	"symbols",
	"changeset",
	"intelligence",
	"control",
];

/** Build all relevant panels, ordered by (priority, stable panel order). */
export function buildPanels(input: {
	state: AiraSessionState;
	workingSet: readonly WorkbenchFileRow[];
	symbols: readonly WorkbenchSymbolRow[];
	finding: WorkbenchFinding | undefined;
}): WorkbenchPanel[] {
	const candidates = [
		interactionPanel(input.state),
		findingPanel(input.finding),
		verificationPanel(input.state),
		goalPanel(input.state),
		tasksPanel(input.state),
		executionPanel(input.state),
		browserPanel(input.state),
		workingSetPanel(input.workingSet),
		symbolsPanel(input.symbols),
		changesetPanel(input.workingSet),
		intelligencePanel(input.state),
		controlPanel(input.state),
	];
	const panels = candidates.filter((panel): panel is WorkbenchPanel => panel !== undefined);
	panels.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return PANEL_ORDER.indexOf(a.id) - PANEL_ORDER.indexOf(b.id);
	});
	return panels;
}
