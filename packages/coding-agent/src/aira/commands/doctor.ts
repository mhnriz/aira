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
import { classifyAiraCapability, isAiraCapabilityReadOnly } from "../capabilities.ts";
import { AIRA_MODE_CYCLE, AIRA_MUTATING_TOOLS, AIRA_READ_ONLY_TOOLS } from "../modes.ts";
import { displayPathUnderHome, getAiraHome } from "../paths.ts";
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

	// 5. PLAN read-only boundary.
	const mutating = ["bash", "powershell", "edit", "write"].filter((t) => AIRA_MUTATING_TOOLS.has(t));
	const readOnly = AIRA_READ_ONLY_TOOLS.filter((t) => AIRA_READ_ONLY_TOOLS.includes(t));
	checks.push({
		name: "plan read-only",
		pass: mutating.length === 4 && readOnly.length === 4,
		detail: `blocked: ${mutating.join(", ")} | allowed: ${readOnly.join(", ")}`,
	});

	// 6. Semantic capability classification contract.
	const classifiedReadOnly = ["read", "grep", "find", "ls"].every((t) => classifyAiraCapability(t) === "read-only");
	const classifiedMutating = ["edit", "write", "bash", "powershell"].every((t) => !isAiraCapabilityReadOnly(t));
	const unknownPermissive =
		!isAiraCapabilityReadOnly("unknown-extension-tool") && !AIRA_MUTATING_TOOLS.has("unknown-extension-tool");
	checks.push({
		name: "capabilities",
		pass: classifiedReadOnly && classifiedMutating && unknownPermissive,
		detail: `read-only: read, grep, find, ls | mutating/process: edit, write, bash, powershell | unknown: not flagged mutating`,
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

	return { product: "Aira doctor", home: displayPathUnderHome(home), checks };
}

function liveCodeLine(live: { status: string; servers: Array<{ available: boolean }>; crashCount: number }): string {
	if (live.status === "ready") {
		return `live-code: ready (${live.servers.filter((s) => s.available).length} server(s))`;
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
