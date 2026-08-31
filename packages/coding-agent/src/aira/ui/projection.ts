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
import { buildFooterSegments } from "./footer.ts";
import { buildPanels } from "./panels.ts";
import type {
	WorkbenchFinding,
	WorkbenchFooterSegment,
	WorkbenchPanel,
	WorkbenchProjection,
	WorkbenchProjectionInput,
} from "./types.ts";
import { resolveWorkbenchVisibility, workbenchLayoutFor } from "./visibility.ts";

/** Compose footer rows from left/right groups with responsive dropping. */
export function arbitrateFooterSegments(
	left: readonly WorkbenchFooterSegment[],
	right: readonly WorkbenchFooterSegment[],
	width: number,
	separatorWidth = 1,
): WorkbenchFooterSegment[] {
	const activeLeft = [...left];
	const activeRight = [...right];
	const anyLeft = () => activeLeft.length > 0;
	const measure = () => {
		const leftWidth = sumWidths(activeLeft, separatorWidth);
		const rightWidth = sumWidths(activeRight, separatorWidth);
		const join = anyLeft() && activeRight.length > 0 ? separatorWidth * 2 : 0;
		return leftWidth + rightWidth + join;
	};

	// Drop phase: remove lowest dropRank segments until the rail fits.
	const droppable = [...activeLeft, ...activeRight]
		.filter((segment) => !segment.required && Number.isFinite(segment.dropRank))
		.sort((a, b) => a.dropRank - b.dropRank);
	for (const segment of droppable) {
		if (measure() <= width) break;
		removeSegment(activeLeft, segment);
		removeSegment(activeRight, segment);
	}

	// Compact phase: required segments shrink to their compact variants.
	const compactable = [...activeLeft, ...activeRight].filter((segment) => segment.required && segment.compact);
	for (const segment of compactable) {
		if (measure() <= width) break;
		segment.text = segment.compact!;
		segment.compact = undefined;
	}

	// Truncate phase (rare): shorten the widest non-required segment first.
	const remaining = [...activeLeft, ...activeRight].filter((segment) => !segment.required);
	let guard = 0;
	while (measure() > width && guard < 16) {
		guard += 1;
		const widest = remaining
			.map((segment) => ({ segment, width: segment.text.length }))
			.sort((a, b) => b.width - a.width)[0];
		if (!widest || widest.width <= 3) break;
		widest.segment.text = `${widest.segment.text.slice(0, widest.width - 2)}…`;
	}

	return [...activeLeft, ...activeRight];
}

function removeSegment(list: WorkbenchFooterSegment[], segment: WorkbenchFooterSegment): void {
	const index = list.indexOf(segment);
	if (index !== -1) list.splice(index, 1);
}

function sumWidths(segments: readonly WorkbenchFooterSegment[], separatorWidth: number): number {
	let total = 0;
	for (const segment of segments) {
		if (total > 0) total += separatorWidth + 2; // " │ " around each separator
		total += segment.text.length;
	}
	return total;
}

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
		finding,
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
