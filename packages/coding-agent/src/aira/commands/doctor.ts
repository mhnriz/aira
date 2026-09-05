/**
 * Aira core — native `/doctor` command (Phase 3 scope).
 *
 * A restrained, deterministic health check for the native modes/UX surface.
 * It verifies wiring between the canonical session state, host keybindings,
 * and the PLAN read-only enforcement boundary. Deliberately not a diagnostic
 * dashboard: each check is trivially readable and a pass/fail is unambiguous.
 *
 * Checks (Phase 3):
 *  - canonical home resolves to `~/.aira` (not `~/.pi`);
 *  - canonical session state is present and its mode is valid;
 *  - the mode-cycle keybinding default is Shift+Tab;
 *  - the thinking-cycle keybinding default moved off Shift+Tab to Ctrl+Shift+E
 *    (so a user who never customized Shift+Tab gets mode cycling);
 *  - the PLAN read-only boundary classifies the mutating built-in tools and
 *    keeps the read-only inspection tools available;
 *  - the semantic capability classification contract classifies every built-in
 *    capability without flagging unknown (extension) tools as mutating;
 *  - the canonical session state carries a resolved project profile (Phase 4).
 *
 * Later phases extend this with capability/runtime health.
 */
import { CONFIG_DIR_NAME } from "../../config.ts";
import { KEYBINDINGS } from "../../core/keybindings.ts";
import { getThemeByName } from "../../modes/interactive/theme/theme.ts";
import { classifyAiraBrowserOperation, classifyAiraCapability, isAiraCapabilityReadOnly } from "../capabilities.ts";
import { AIRA_MODE_CYCLE, AIRA_MUTATING_TOOLS, AIRA_READ_ONLY_TOOLS, isAiraMutatingTool } from "../modes.ts";
import { displayPathUnderHome, getAiraHome } from "../paths.ts";
import { AIRA_PERMISSION_MODES, evaluateAiraPermissionRequest } from "../permissions/index.ts";
import { summarizeAiraProject } from "../project/profile.ts";
import type { AiraSessionState } from "../state.ts";

export interface AiraDoctorCheck {
	name: string;
	pass: boolean;
	detail: string;
}

export interface AiraDoctorReport {
	product: string;
	home: string;
	checks: AiraDoctorCheck[];
}

const MODE_CYCLE_KEY = "app.mode.cycle";
const THINKING_CYCLE_KEY = "app.thinking.cycle";
const WORKBENCH_TOGGLE_KEY = "app.workbench.toggle";

function defaultKeysOf(action: string): string[] {
	const def = (KEYBINDINGS as Record<string, { defaultKeys?: string | string[] }>)[action];
	const keys = def?.defaultKeys;
	if (keys === undefined) return [];
	return Array.isArray(keys) ? [...keys] : [keys];
}

function isResolvableKey(action: string, key: string): boolean {
	return defaultKeysOf(action).includes(key);
}

/** Build the doctor report from canonical state and the host keybinding defaults. */
export function buildAiraDoctorReport(state: AiraSessionState | undefined): AiraDoctorReport {
	const home = getAiraHome();
	const checks: AiraDoctorCheck[] = [];

	// 1. Canonical home.
	const homeLeaf = home.split(/[\\/]/).pop() ?? "";
	checks.push({
		name: "home",
		pass: homeLeaf === CONFIG_DIR_NAME,
		detail: `${displayPathUnderHome(home)} (${homeLeaf === CONFIG_DIR_NAME ? "canonical Aira home" : `expected ${CONFIG_DIR_NAME}`})`,
	});

	// 2. Canonical session state + valid mode.
	if (!state) {
		checks.push({ name: "session state", pass: false, detail: "no canonical AiraSessionState (wiring bug)" });
	} else {
		checks.push({
			name: "session state",
			pass: AIRA_MODE_CYCLE.includes(state.mode),
			detail: `mode ${state.mode} (${state.runtime})`,
		});
	}

	// 3. Mode-cycle keybinding (Shift+Tab by default).
	checks.push({
		name: "mode shortcut",
		pass: isResolvableKey(MODE_CYCLE_KEY, "shift+tab"),
		detail: `${MODE_CYCLE_KEY}: ${defaultKeysOf(MODE_CYCLE_KEY).join(", ") || "unbound"}`,
	});

	// 4. Thinking cycle moved off Shift+Tab.
	const thinkingKeys = defaultKeysOf(THINKING_CYCLE_KEY);
	checks.push({
		name: "thinking shortcut",
		pass: thinkingKeys.includes("ctrl+shift+e") && !thinkingKeys.includes("shift+tab"),
		detail: `${THINKING_CYCLE_KEY}: ${thinkingKeys.join(", ") || "unbound"}`,
	});

	// 4b. Phase 12 Workbench uses its own semantic shortcut; established
	// Ctrl+O tool-output expansion remains intact.
	const workbenchKeys = defaultKeysOf(WORKBENCH_TOGGLE_KEY);
	const expandKeys = defaultKeysOf("app.tools.expand");
	checks.push({
		name: "workbench shortcut",
		pass: workbenchKeys.includes("ctrl+shift+o") && expandKeys.includes("ctrl+o"),
		detail: `${WORKBENCH_TOGGLE_KEY}: ${workbenchKeys.join(", ") || "unbound"} | app.tools.expand: ${expandKeys.join(", ") || "unbound"}`,
	});

	// 4c. Phase 12.1 viewport focus uses a distinct binding and never steals
	// Ctrl+A (editor line-start) or the Ctrl+O family.
	const focusKeys = defaultKeysOf("app.viewport.focusCycle");
	const lineStartKeys = defaultKeysOf("tui.editor.cursorLineStart");
	checks.push({
		name: "viewport focus shortcut",
		pass: focusKeys.includes("alt+o") && !focusKeys.includes("ctrl+a") && lineStartKeys.includes("ctrl+a"),
		detail: `app.viewport.focusCycle: ${focusKeys.join(", ") || "unbound"} | editor line-start: ${lineStartKeys.join(", ") || "unbound"}`,
	});

	// 4d. Aira default theme resolves (schema-valid built-in).
	const airaTheme = getThemeByName("aira-zhr");
	checks.push({
		name: "aira-zhr theme",
		pass: airaTheme !== undefined,
		detail: airaTheme
			? `resolved (${getThemeByName("dark")?.name ?? "dark"} classic fallback intact)`
			: "not resolvable (theme wiring bug)",
	});

	// 5. PLAN read-only boundary: mutating/process/browser-interaction tools
	// blocked, read-only surface allowed. Derived from the semantic tables, so
	// the check stays truthful as the sets grow (Phases 6-7).
	const mutating = [
		"bash",
		"powershell",
		"edit",
		"write",
		"process_start",
		"process_stop",
		"browser_open",
		"browser_click",
		"browser_verify",
	].filter((t) => AIRA_MUTATING_TOOLS.has(t));
	const readOnly = AIRA_READ_ONLY_TOOLS.filter((t) => isAiraBrowserObservation(t));
	const semanticBlocked = ["browser_click", "browser_verify", "browser_open"].every((t) => isAiraMutatingTool(t));
	const semanticAllowed = ["browser_observe", "browser_navigate", "browser_console"].every(
		(t) => !isAiraMutatingTool(t),
	);
	checks.push({
		name: "plan read-only",
		pass: mutating.length === 9 && readOnly.length >= 6 && semanticBlocked && semanticAllowed,
		detail: `blocked: ${mutating.join(", ")} | allowed: ${readOnly.join(", ")} | browser semantics: observe/navigate allowed, interact/lifecycle blocked`,
	});

	// 6. Semantic capability classification contract.
	const classifiedReadOnly = ["read", "grep", "find", "ls", "process_status", "process_logs"].every(
		(t) => classifyAiraCapability(t) === "read-only" || classifyAiraCapability(t) === "diagnostic",
	);
	const classifiedMutating = ["edit", "write", "bash", "powershell", "process_start", "process_stop"].every(
		(t) => !isAiraCapabilityReadOnly(t),
	);
	const unknownPermissive =
		!isAiraCapabilityReadOnly("unknown-extension-tool") && !AIRA_MUTATING_TOOLS.has("unknown-extension-tool");
	checks.push({
		name: "capabilities",
		pass: classifiedReadOnly && classifiedMutating && unknownPermissive,
		detail: `read-only/diagnostic: read, grep, find, ls, process_status, process_logs | mutating/process: edit, write, bash, powershell, process_start, process_stop | unknown: not flagged mutating`,
	});

	// 7. Project awareness: canonical state carries a resolved project profile.
	checks.push({
		name: "project",
		pass: state?.project !== undefined,
		detail: state?.project ? summarizeAiraProject(state.project) : "not resolved yet (project awareness wiring)",
	});

	// 8. Intelligence service: activation decision + health snapshot.
	const intelligence = state?.intelligence;
	if (!intelligence) {
		checks.push({
			name: "intelligence",
			pass: false,
			detail: "no intelligence snapshot (coordinator wiring)",
		});
	} else if (!intelligence.active) {
		checks.push({
			name: "intelligence",
			pass: true,
			detail: `inactive: ${intelligence.activationReason}`,
		});
	} else {
		const live = intelligence.liveCode;
		const repo = intelligence.repository;
		const repoLine = `${repo.status} (${repo.filesIndexed} files${repo.cacheLoaded ? ", cached" : ""}${repo.changesAvailable ? `, ${repo.changeCount ?? 0} changed` : ""})`;
		const liveLine = liveCodeLine(live);
		checks.push({
			name: "intelligence",
			pass: !intelligence.degraded,
			detail: `repository: ${repoLine} | ${liveLine} | findings: ${intelligence.findings.errors} errors / ${intelligence.findings.warnings} warnings`,
		});
	}

	// 9. Execution runtime: armed manager + bounded snapshot in canonical state.
	const execution = state?.execution;
	if (!execution) {
		checks.push({
			name: "execution",
			pass: false,
			detail: "no execution snapshot (runtime wiring)",
		});
	} else if (!execution.active) {
		checks.push({
			name: "execution",
			pass: true,
			detail: `inactive (${execution.processes.length} process(es) retained)`,
		});
	} else {
		const running = execution.processes.filter((p) => p.status === "running").length;
		const degraded = execution.degraded ? " · degraded" : "";
		checks.push({
			name: "execution",
			pass: !execution.degraded,
			detail: `active · ${execution.processes.length} process(es) (${running} running) · ${execution.recentResults.length} recent result(s)${degraded}`,
		});
	}

	// 10. Browser runtime: canonical snapshot + truthful states. A browser is
	// an OPTIONAL capability: "availability unknown" is only a pass when the
	// runtime has not probed yet; absence of a browser is NOT a failure —
	// `unavailable` is the truthful, healthy answer for machines without one.
	const browser = state?.browser;
	if (!browser) {
		checks.push({
			name: "browser",
			pass: false,
			detail: "no browser snapshot (runtime wiring)",
		});
	} else if (browser.availability === "unknown") {
		checks.push({
			name: "browser",
			pass: true,
			detail: "availability probe pending (lazy arm; no browser launched)",
		});
	} else {
		const tabs = browser.tabs.length > 0 ? ` · ${browser.tabs.length} tab(s)` : "";
		const consoleLine = `${browser.console.errors}E ${browser.console.warnings}W`;
		const networkLine = `${browser.network.failures} failed`;
		const check = browser.verification.status !== "none" ? ` · check ${browser.verification.status}` : "";
		const degraded = browser.status === "degraded" ? ` · degraded${browser.reason ? `: ${browser.reason}` : ""}` : "";
		checks.push({
			name: "browser",
			pass: browser.status !== "degraded",
			detail: `${browser.availability} · ${browser.status}${tabs} · console ${consoleLine} · network ${networkLine}${check}${degraded}${
				browser.status === "unavailable"
					? ` · ${browser.reason ?? "no browser executable (optional capability)"}`
					: ""
			}`,
		});
	}

	// 11. Independent verification: canonical settings + snapshot. Health
	// reporting NEVER runs a verification (no model tokens): it reflects the
	// manager wiring and the last verdict/staleness. A verifier driver error
	// is reported truthfully but is not a doctor failure — verification
	// failure must not break the host.
	const verification = state?.verification;
	if (!verification) {
		checks.push({
			name: "verifier",
			pass: false,
			detail: "no verification snapshot (manager wiring)",
		});
	} else {
		const result = verification.currentResult;
		const verdictLine = result
			? `${result.verdict}${verification.stale ? " (stale)" : " (current)"} · ${result.requirements.filter((r) => r.status === "verified").length}/${result.requirements.length} requirements`
			: "no result yet";
		const errorLine = verification.lastError ? ` · last error: ${verification.lastError}` : "";
		const skipLine = verification.lastSkipReason ? ` · last skip: ${verification.lastSkipReason}` : "";
		checks.push({
			name: "verifier",
			pass: true,
			detail: `${verification.enabled ? "enabled" : "disabled"} · auto ${verification.auto} · budget ${verification.contextBudget} · state ${verification.status} · ${verdictLine}${errorLine}${skipLine}`,
		});
	}

	// 12. Orchestration: canonical settings + snapshot. Health reporting never
	// dispatches children (no model tokens). A disabled feature reports its
	// disabled state truthfully and is NOT a failure; active children and
	// bounded failure telemetry are reflected. Orchestration failure must not
	// break the host.
	const orchestration = state?.orchestration;
	if (!orchestration) {
		checks.push({
			name: "orchestration",
			pass: false,
			detail: "no orchestration snapshot (manager wiring)",
		});
	} else {
		const active = orchestration.runningCount + orchestration.queuedCount;
		const failureLine =
			orchestration.failures.length > 0 ? ` · ${orchestration.failures.length} failure(s) in bounded telemetry` : "";
		checks.push({
			name: "orchestration",
			pass: true,
			detail: `${orchestration.enabled ? "enabled" : "disabled"} · ${orchestration.status} · concurrency ${orchestration.runningCount}/${orchestration.maxConcurrency} · ${orchestration.children.length} child record(s) (${active} active)${failureLine}`,
		});
	}

	// 13. Goal runtime: canonical settings + snapshot + persistence health.
	// Health reporting NEVER promotes a goal (no model tokens) and never
	// changes goal state; a disabled feature reports truthfully. Goal runtime
	// failure must not break the host.
	const goal = state?.goal;
	if (!goal) {
		checks.push({
			name: "goal",
			pass: false,
			detail: "no goal snapshot (manager wiring)",
		});
	} else {
		const persistenceLine =
			goal.persistence.status === "failed"
				? ` · persistence FAILED${goal.persistence.error ? `: ${goal.persistence.error}` : ""}`
				: ` · persistence ${goal.persistence.status}`;
		const usageLine =
			goal.usage.consumedTokens !== undefined ? ` · ${goal.usage.consumedTokens} tokens consumed` : "";
		const waitingLine = goal.waiting ? ` · waiting: ${goal.waiting.reason}` : "";
		checks.push({
			name: "goal",
			pass: true,
			detail: `${goal.enabled ? "enabled" : "disabled"} · auto ${goal.auto} · ${goal.status}${goal.objective ? ` · "${goal.objective}"` : ""} · round ${goal.round}/${goal.maxRounds} · max rounds ${goal.maxRounds}${goal.budget.tokens !== undefined ? ` · token budget ${goal.budget.tokens}` : ""}${goal.budget.maxDurationMs !== undefined ? ` · duration ${Math.round(goal.budget.maxDurationMs / 60000)}m` : ""}${usageLine}${waitingLine}${persistenceLine}`,
		});
	}

	// 14. Permission controller: canonical settings + snapshot + store health.
	// Health reporting never evaluates a request (token-free by construction);
	// a failed persistent store is reported truthfully but must NOT break the
	// host (rules keep applying in-session). PLAN is absolute by design: the
	// check below proves no permission mode can weaken the read-only boundary.
	const permissions = state?.permissions;
	if (!permissions) {
		checks.push({
			name: "permissions",
			pass: false,
			detail: "no permission snapshot (controller wiring)",
		});
	} else {
		const storeLine =
			permissions.store.status === "failed"
				? ` · store FAILED${permissions.store.error ? `: ${permissions.store.error}` : ""}`
				: ` · store ${permissions.store.status}`;
		const planBoundaryHolds = AIRA_PERMISSION_MODES.every(
			(mode) =>
				evaluateAiraPermissionRequest(
					{ tool: "edit", capability: "mutating", subject: "/tmp/x" },
					{ mode, rules: [], plan: true },
				).action === "deny" &&
				evaluateAiraPermissionRequest(
					{ tool: "bash", capability: "process", subject: "npm test" },
					{ mode, rules: [], plan: true },
				).action === "deny",
		);
		checks.push({
			name: "permissions",
			pass: permissions.enabled && permissions.mode !== undefined && planBoundaryHolds,
			detail: `${permissions.enabled ? "enabled" : "disabled"} · mode ${permissions.mode} · ${permissions.persistentRules} persistent rule(s) · ${permissions.sessionRules} session rule(s) · ${permissions.onceApprovals} once approval(s)${storeLine}${planBoundaryHolds ? " · PLAN absolute (no mode can weaken read-only)" : " · PLAN boundary BROKEN"}`,
		});
	}

	// 15. Interaction: canonical snapshot + pending question truth. Health
	// reporting never opens a question (no prompts, no model tokens); a
	// pending question is reflected, never resolved by the doctor.
	const interaction = state?.interaction;
	if (!interaction) {
		checks.push({
			name: "interaction",
			pass: false,
			detail: "no interaction snapshot (manager wiring)",
		});
	} else {
		const pendingLine = interaction.pending
			? ` · PENDING ${interaction.question?.type ?? "question"}: "${interaction.question?.prompt ?? ""}" (${Math.round((interaction.question?.durationMs ?? 0) / 1000)}s)`
			: " · idle";
		checks.push({
			name: "interaction",
			pass: true,
			detail: `${interaction.uiAttached ? "UI attached" : "no UI attached (headless — questions resolve unavailable)"}${pendingLine}`,
		});
	}

	// 16. Task graph: canonical settings + snapshot. Health reporting never
	// mutates tasks; a disabled feature reports truthfully and is NOT a
	// failure. Task state failure must not break the host.
	const tasks = state?.tasks;
	if (!tasks) {
		checks.push({
			name: "tasks",
			pass: false,
			detail: "no task snapshot (manager wiring)",
		});
	} else {
		const persistence = tasks.persistence;
		const persistenceLine = persistence
			? ` · persistence ${persistence.status}${persistence.error ? `: ${persistence.error}` : ""}`
			: " · persistence unavailable";
		checks.push({
			name: "tasks",
			pass: true,
			detail: `${tasks.enabled ? "enabled" : "disabled"} · ${tasks.total} task(s) · ${tasks.completed} completed · ${tasks.active} active · ${tasks.blocked} blocked · ${tasks.childRows} orchestration-projected row(s)${persistenceLine}`,
		});
	}

	return { product: "Aira doctor", home: displayPathUnderHome(home), checks };
}

/** Browser observation tools in the PLAN read-only set (Phase 7). */
function isAiraBrowserObservation(name: string): boolean {
	return classifyAiraBrowserOperation(name) === "observe" || classifyAiraBrowserOperation(name) === "navigate";
}

function liveCodeLine(live: { status: string; servers: Array<{ available: boolean }>; crashCount: number }): string {
	if (live.status === "ready") {
		return `live-code: ready (${live.servers.filter((s) => s.available).length} server(s))`;
	}
	if (live.status === "idle") {
		return `live-code: idle (${live.servers.filter((s) => s.available).length} server(s) available)`;
	}
	const crashes = live.crashCount > 0 ? ` (${live.crashCount} crash(es))` : "";
	return `live-code: ${live.status}${crashes}`;
}

export function formatAiraDoctorReport(report: AiraDoctorReport): string {
	const lines = [report.product, `home: ${report.home}`];
	for (const check of report.checks) {
		lines.push(`${check.pass ? "ok" : "FAIL"}  ${check.name}: ${check.detail}`);
	}
	lines.push(`summary: ${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
	return lines.join("\n");
}
