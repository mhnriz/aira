/**
 * Aira UI — Workbench projection orchestrator.
 *
 * `projectWorkbench` is THE coordination layer between canonical subsystem
 * snapshots and the renderers (sidebar + footer). It is purely derived:
 * - consumes `AiraSessionState` + bounded seam inputs (working set, symbols);
 * - produces panels, footer segments, visibility, and the current finding;
 * - owns NO business logic and NO state — it is a pure function.
 *
 * Rendering this projection consumes zero model tokens by construction.
 */

import type { AiraSessionState } from "../state.ts";
import { arbitrateCurrentFinding } from "./finding.ts";
import { arbitrateFooterSegments, buildFooterSegments } from "./footer.ts";
import { buildPanels } from "./panels.ts";
import type { WorkbenchFinding, WorkbenchPanel, WorkbenchProjection, WorkbenchProjectionInput } from "./types.ts";
import { resolveWorkbenchVisibility, workbenchLayoutFor } from "./visibility.ts";

/**
 * Project the full Workbench from canonical state. Pure and token-free.
 */
export function projectWorkbench(input: WorkbenchProjectionInput): WorkbenchProjection {
	const { state, width, settings } = input;

	const layout = workbenchLayoutFor(width);
	const sidebarVisible = resolveWorkbenchVisibility({
		width,
		enabled: settings.enabled,
		showOnStartup: settings.showOnStartup,
		sidebarWidth: settings.width,
		explicitVisible: input.explicitVisible,
	});

	const finding = arbitrateCurrentFinding(state);

	let panels: WorkbenchPanel[] = buildPanels({
		state,
		workingSet: input.workingSet,
		symbols: input.symbols,
		checkpoints: input.checkpoints,
		finding,
		inspectedRunId: input.inspectedRunId,
	});

	// Density + layout shaping (bounded, deterministic).
	if (layout === "medium") {
		panels = panels
			.filter((panel) => !panel.mediumHidden)
			.map((panel) => ({
				...panel,
				rows: panel.mediumCap !== undefined ? panel.rows.slice(0, panel.mediumCap) : panel.rows,
			}));
	}
	if (settings.density === "compact") {
		// Compact density only tightens spacing (renderer concern); rows stay.
	}

	const { left, right } = buildFooterSegments({
		state,
		finding,
		cwd: input.cwd,
		branch: input.branch,
		context: input.context,
		modelId: input.modelId,
		thinkingLevel: input.thinkingLevel,
	});

	const footer = arbitrateFooterSegments(left, right, width);

	const summary = buildSummary(finding, state);
	return { layout, sidebarVisible, panels, footer, finding, summary };
}

function buildSummary(finding: WorkbenchFinding | undefined, state: AiraSessionState): string {
	const mode = state.mode.toUpperCase();
	if (finding) {
		const code = finding.code ? `${finding.code} · ` : "";
		return `${mode} · ${code}${finding.label}`;
	}
	const running = (state.orchestration?.runningCount ?? 0) + (state.orchestration?.queuedCount ?? 0);
	const parts = [mode];
	if (running > 0) parts.push(`agents ${running}`);
	if (state.goal && state.goal.status !== "idle") parts.push(`goal ${state.goal.status}`);
	return parts.join(" · ");
}
