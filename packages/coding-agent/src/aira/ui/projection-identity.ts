/**
 * Workbench projection identity.
 *
 * The Workbench rail renders exactly `projection.panels` (see
 * `renderWorkbenchPanels`); the title strip reads live focus/follow state and
 * is compared separately by the controller. The projection's `footer`,
 * `finding`, and `summary` fields are consumed by other surfaces, and `footer`
 * in particular carries token-granular context percent / usage text. They are
 * therefore deliberately excluded here so that stream ticks do not dirty the
 * rail.
 *
 * "Visually equivalent" therefore means: same layout class, same visibility,
 * and every field the rail actually paints (panel identity/priority/hint/caps,
 * rows, and progress) is equal. Callers must not treat these projections as
 * interchangeable for consumers of the excluded fields.
 */

import type { WorkbenchPanel, WorkbenchProjection, WorkbenchRow } from "./types.ts";

function rowsEqual(a: readonly WorkbenchRow[], b: readonly WorkbenchRow[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (
			x.label !== y.label ||
			x.value !== y.value ||
			x.role !== y.role ||
			x.trailing !== y.trailing ||
			x.trailingRole !== y.trailingRole ||
			x.detail !== y.detail ||
			x.key !== y.key
		) {
			return false;
		}
	}
	return true;
}

function panelsEqual(a: readonly WorkbenchPanel[], b: readonly WorkbenchPanel[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (
			x.id !== y.id ||
			x.title !== y.title ||
			x.priority !== y.priority ||
			x.hint !== y.hint ||
			x.mediumCap !== y.mediumCap ||
			x.mediumHidden !== y.mediumHidden ||
			x.progress?.value !== y.progress?.value ||
			x.progress?.role !== y.progress?.role ||
			!rowsEqual(x.rows, y.rows)
		) {
			return false;
		}
	}
	return true;
}

/** True when two projections paint the same Workbench rail content. */
export function workbenchProjectionEquals(
	a: WorkbenchProjection | undefined,
	b: WorkbenchProjection | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.layout === b.layout && a.sidebarVisible === b.sidebarVisible && panelsEqual(a.panels, b.panels);
}
