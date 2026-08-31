/**
 * Aira Workbench — regular-mode TUI rail extension.
 *
 * Terminal-native (non-fullscreen) rendering has no layout tree, so the
 * Workbench rail is a NATIVE overlay (viewport-fixed right column; see the
 * controller) plus a base-width shrink so conversation text never hides
 * under the rail. This subclass owns the shrink; the overlay is mounted
 * through the standard `showOverlay` API (no patching).
 *
 * The footer (full-width child) stays at the full terminal width so the
 * status rail never competes with the sidebar for the same row.
 */

import { type Component, TuiMainScreen } from "@earendil-works/pi-tui";

export class AiraTuiMainScreen extends TuiMainScreen {
	private sidebarRail: Component | undefined;
	private railWidthProvider: () => number = () => 0;
	private fullWidthChildren = new Set<Component>();

	/** Attach/detach the sidebar rail (width provider + full-width children). */
	setSidebarRail(input: {
		rail: Component | undefined;
		getWidth: () => number;
		fullWidthChildren?: ReadonlyArray<Component>;
	}): void {
		this.sidebarRail = input.rail;
		this.railWidthProvider = input.getWidth;
		this.fullWidthChildren = new Set(input.fullWidthChildren ?? []);
	}

	/** Effective rail width for a terminal width (0 = no rail visible). */
	railWidthFor(terminalWidth: number): number {
		if (this.sidebarRail === undefined) return 0;
		const width = Math.trunc(this.railWidthProvider());
		if (width <= 0) return 0;
		return Math.max(0, Math.min(width, terminalWidth - 1));
	}

	override render(width: number): string[] {
		const railWidth = this.railWidthFor(width);
		if (railWidth <= 0) {
			return super.render(width);
		}
		const mainWidth = Math.max(1, width - railWidth);
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = this.fullWidthChildren.has(child) ? child.render(width) : child.render(mainWidth);
			lines.push(...childLines);
		}
		return lines;
	}
}
