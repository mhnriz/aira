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
	private dockAnchor: Component | undefined;
	/** Row index where the first full-width child's lines begin (last render). */
	private lastFooterStartRow = 0;

	/** Attach/detach the sidebar rail (width provider + full-width children). */
	setSidebarRail(input: {
		rail: Component | undefined;
		getWidth: () => number;
		fullWidthChildren?: ReadonlyArray<Component>;
		dockAnchor?: Component;
	}): void {
		this.sidebarRail = input.rail;
		this.railWidthProvider = input.getWidth;
		this.fullWidthChildren = new Set(input.fullWidthChildren ?? []);
		this.dockAnchor = input.dockAnchor;
	}

	/** Effective rail width for a terminal width (0 = no rail visible). */
	railWidthFor(terminalWidth: number): number {
		if (this.sidebarRail === undefined) return 0;
		const width = Math.trunc(this.railWidthProvider());
		if (width <= 0) return 0;
		return Math.max(0, Math.min(width, terminalWidth - 1));
	}

	/**
	 * Row (in the composed document) where the footer begins after the last
	 * render — the rail must never paint over the footer, wherever it sits
	 * (short documents leave the footer mid-screen in regular mode).
	 */
	get footerStartRow(): number {
		return this.lastFooterStartRow;
	}

	override render(width: number): string[] {
		const railWidth = this.railWidthFor(width);
		const mainWidth = railWidth > 0 ? Math.max(1, width - railWidth) : width;
		const renderedChildren = this.children.map((child) => ({
			child,
			lines: child.render(this.fullWidthChildren.has(child) ? width : mainWidth),
		}));
		const renderedLineCount = renderedChildren.reduce((total, rendered) => total + rendered.lines.length, 0);
		const anchorFill = this.dockAnchor ? Math.max(0, this.terminal.rows - renderedLineCount) : 0;
		const lines: string[] = [];
		let footerStart = 0;
		for (const rendered of renderedChildren) {
			const { child, lines: childLines } = rendered;
			if (child === this.dockAnchor && anchorFill > 0) {
				lines.push(...Array.from({ length: anchorFill }, () => ""));
			}
			if (this.fullWidthChildren.has(child)) {
				footerStart = lines.length;
			}
			lines.push(...childLines);
		}
		this.lastFooterStartRow = footerStart;
		return lines;
	}
}
