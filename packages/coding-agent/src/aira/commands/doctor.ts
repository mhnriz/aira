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
 *    keeps the read-only inspection tools available.
 *
 * Later phases extend this with project/capability/runtime health.
 */
import { CONFIG_DIR_NAME } from "../../config.ts";
import { KEYBINDINGS } from "../../core/keybindings.ts";
import { AIRA_MODE_CYCLE, AIRA_MUTATING_TOOLS, AIRA_READ_ONLY_TOOLS } from "../modes.ts";
import { displayPathUnderHome, getAiraHome } from "../paths.ts";
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

	return { product: "Aira doctor", home: displayPathUnderHome(home), checks };
}

export function formatAiraDoctorReport(report: AiraDoctorReport): string {
	const lines = [report.product, `home: ${report.home}`];
	for (const check of report.checks) {
		lines.push(`${check.pass ? "ok" : "FAIL"}  ${check.name}: ${check.detail}`);
	}
	lines.push(`summary: ${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
	return lines.join("\n");
}
