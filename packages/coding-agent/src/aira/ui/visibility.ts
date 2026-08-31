/**
 * Aira UI — visibility policy for the Workbench sidebar.
 *
 * A pure function of (terminal width, canonical settings, explicit user
 * choice). Owns the responsive rules (single source of truth for both the
 * projection and the renderer controller):
 *
 * - Default (no explicit choice): visible on sufficiently wide terminals,
 *   auto-hidden below the safe minimum width.
 * - Explicit OFF: stays off while wide; narrow hides it anyway (auto-hide
 *   always wins); widening back never resurrects it without the user.
 * - Explicit ON: stays on while wide; narrow hides it anyway; widening back
 *   restores it (the user asked for it).
 *
 * Deterministic and side-effect free.
 */

import { MAX_WORKBENCH_WIDTH, MIN_WORKBENCH_MAIN_WIDTH, MIN_WORKBENCH_WIDTH } from "../../core/settings-manager.ts";
import type { WorkbenchLayout } from "./types.ts";

/** Below this width the sidebar is ALWAYS hidden (conversation-only). */
export const WORKBENCH_NARROW_LIMIT = MIN_WORKBENCH_MAIN_WIDTH + MIN_WORKBENCH_WIDTH;

/** Above this width the layout is "wide" (full adaptive Workbench). */
export const WORKBENCH_MEDIUM_LIMIT = 118;

/** Safe minimum width for the sidebar at a configured sidebar width. */
export function workbenchSafeMinimum(sidebarWidth: number): number {
	return MIN_WORKBENCH_MAIN_WIDTH + Math.min(MAX_WORKBENCH_WIDTH, Math.max(MIN_WORKBENCH_WIDTH, sidebarWidth));
}

/** Derive the layout class from terminal width (wide / medium / narrow). */
export function workbenchLayoutFor(width: number): WorkbenchLayout {
	if (width >= WORKBENCH_MEDIUM_LIMIT) return "wide";
	if (width >= WORKBENCH_NARROW_LIMIT) return "medium";
	return "narrow";
}

/**
 * Resolve effective sidebar visibility.
 *
 * @param width terminal width in columns
 * @param enabled canonical workbench.enabled
 * @param showOnStartup canonical workbench.showOnStartup
 * @param sidebarWidth configured sidebar width
 * @param explicitVisible user's explicit choice (undefined = none yet)
 */
export function resolveWorkbenchVisibility(input: {
	width: number;
	enabled: boolean;
	showOnStartup: boolean;
	sidebarWidth: number;
	explicitVisible: boolean | undefined;
}): boolean {
	if (!input.enabled) return false;
	if (input.width < workbenchSafeMinimum(input.sidebarWidth)) return false;
	// Explicit OFF always wins on safe widths; default follows showOnStartup.
	return input.explicitVisible === false ? false : input.explicitVisible === true || input.showOnStartup;
}

/** Whether the terminal is too narrow for the sidebar regardless of choice. */
export function isWorkbenchNarrow(width: number, sidebarWidth: number): boolean {
	return width < workbenchSafeMinimum(sidebarWidth);
}
