/**
 * Aira conversation — compact tool grouping.
 *
 * Consecutive successful runs of the same quick file tool (read/edit/write/
 * ls/grep/find) collapse into one compact activity row with per-file
 * sub-lines:
 *
 *   ✓ read       4 files
 *     workbench.ts
 *     projection.ts
 *
 * Rules (conservative by design):
 * - only same-tool, adjacent components group;
 * - the group's tail member must be settled and successful before a new
 *   component may join (running rows stay standalone so their live glyph and
 *   duration stay visible);
 * - when any grouped member settles with an error, the group dissolves back
 *   into standalone rows so the failure is never hidden inside a group;
 * - expanding reveals every member's full output; collapsing returns to the
 *   compact group.
 *
 * Pure presentation: members keep receiving result updates normally (the
 * host's pendingTools map is untouched), and canonical results are never
 * altered.
 */

import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { buildCompactRow } from "../../../core/tools/compact.ts";
import { theme } from "../theme/theme.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

const GROUP_LABEL_WIDTH = 40;

/** Tools eligible for grouping (quick file ops; no streaming partial rows). */
const GROUPABLE_TOOL_NOUN = new Map<string, string>([
	["read", "files"],
	["edit", "files"],
	["write", "files"],
	["ls", "entries"],
	["grep", "matches"],
	["find", "results"],
]);

export function isGroupableTool(toolName: string): boolean {
	return GROUPABLE_TOOL_NOUN.has(toolName);
}

export class ToolExecutionGroup extends Container {
	private members: ToolExecutionComponent[] = [];
	private expanded = false;
	private header: Text;
	private onDissolve: (() => void) | undefined;

	constructor() {
		super();
		this.header = new Text("", 0, 0);
		this.addChild(this.header);
	}

	/** Host hook invoked when a grouped member settles with an error. */
	setOnDissolve(callback: (() => void) | undefined): void {
		this.onDissolve = callback;
	}

	/** Whether a new component may join this group right now. */
	canJoin(component: ToolExecutionComponent): boolean {
		if (this.expanded) return false;
		if (this.members.length === 0) return false;
		if (this.members[0].getToolName() !== component.getToolName()) return false;
		if (component.hasImageResult()) return false;
		const last = this.members[this.members.length - 1];
		return last.getStatus() === "success";
	}

	addMember(component: ToolExecutionComponent): void {
		this.members.push(component);
		component.setOnError(() => {
			if (this.members.includes(component)) this.onDissolve?.();
		});
		this.updateHeader();
	}

	getMembers(): readonly ToolExecutionComponent[] {
		return this.members;
	}

	/** Detach all members (group dissolution); clears error hooks. */
	takeMembers(): ToolExecutionComponent[] {
		for (const member of this.members) {
			member.setOnError(undefined);
		}
		const members = this.members;
		this.members = [];
		return members;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const member of this.members) {
			member.setExpanded(expanded);
		}
		this.updateHeader();
	}

	setShowImages(show: boolean): void {
		for (const member of this.members) {
			member.setShowImages(show);
		}
	}

	setImageWidthCells(width: number): void {
		for (const member of this.members) {
			member.setImageWidthCells(width);
		}
	}

	private updateHeader(): void {
		const count = this.members.length;
		const noun = GROUPABLE_TOOL_NOUN.get(this.members[0]?.getToolName() ?? "") ?? "calls";
		const label = this.members[0]?.getToolName() ?? "tool";
		this.header.setText(` ${buildCompactRow(theme, { status: "success", label, targetText: `${count} ${noun}` })}`);
	}

	override render(width: number): string[] {
		const lines: string[] = [...this.header.render(width)];
		if (this.expanded) {
			for (const member of this.members) {
				lines.push(...member.render(width));
			}
			return lines;
		}
		for (const member of this.members) {
			const target = truncateToWidth(
				member.getSummaryTarget() || member.getToolName(),
				GROUP_LABEL_WIDTH,
				"...",
				false,
			);
			lines.push(`   ${target}`);
		}
		return lines;
	}
}

/**
 * Try to place a tool component into (or extending) a tail group of
 * `container`. Returns true when the component was grouped.
 */
export function tryGroupToolComponent(container: Container, component: ToolExecutionComponent): boolean {
	const children = container.children;
	const last = children[children.length - 1];
	if (last instanceof ToolExecutionGroup) {
		// The group owns its dissolution hook already.
		if (last.canJoin(component)) {
			last.addMember(component);
			return true;
		}
		return false;
	}
	if (
		last instanceof ToolExecutionComponent &&
		!last.hasImageResult() &&
		isGroupableTool(last.getToolName()) &&
		last.getToolName() === component.getToolName() &&
		last.getStatus() === "success"
	) {
		const group = new ToolExecutionGroup();
		group.setOnDissolve(() => dissolveGroupFrom(container, group));
		group.addMember(last);
		group.addMember(component);
		const index = children.indexOf(last);
		container.removeChild(last);
		container.insertAt(index, group);
		return true;
	}
	return false;
}

/** Replace a group with its members at the same position (error escalation). */
export function dissolveGroupFrom(container: Container, group: ToolExecutionGroup): void {
	const index = container.children.indexOf(group);
	if (index === -1) return;
	const members = group.takeMembers();
	container.removeChild(group);
	for (let i = 0; i < members.length; i++) {
		container.insertAt(index + i, members[i]);
	}
}

/**
 * After a successful settle, try to fold the component into the previous
 * adjacent group of the same tool. Batches of tool calls are added before
 * any result arrives, so add-time grouping alone misses them; each settle
 * re-checks the now-adjacent rows.
 */
export function regroupToolComponent(container: Container, component: ToolExecutionComponent): void {
	const children = container.children;
	const index = children.indexOf(component);
	if (index <= 0) return;
	const prev = children[index - 1];
	if (prev instanceof ToolExecutionGroup) {
		if (prev.canJoin(component)) {
			container.removeChild(component);
			prev.addMember(component);
		}
		return;
	}
	if (
		prev instanceof ToolExecutionComponent &&
		!prev.hasImageResult() &&
		prev.getToolName() === component.getToolName() &&
		prev.getStatus() === "success"
	) {
		const group = new ToolExecutionGroup();
		group.setOnDissolve(() => dissolveGroupFrom(container, group));
		group.addMember(prev);
		container.removeChild(component);
		group.addMember(component);
		container.removeChild(prev);
		container.insertAt(index - 1, group);
	}
}

/** Invoke `fn` for every tool row in a chat container, flattening groups. */
export function forEachToolRow(container: Container, fn: (component: ToolExecutionComponent) => void): void {
	for (const child of container.children) {
		if (child instanceof ToolExecutionComponent) {
			fn(child);
		} else if (child instanceof ToolExecutionGroup) {
			for (const member of child.getMembers()) {
				fn(member);
			}
		}
	}
}
