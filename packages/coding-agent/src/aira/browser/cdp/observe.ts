/**
 * Aira browser — semantic page observation.
 *
 * Structured observation is the FIRST-class evidence in Aira (screenshots
 * are last). This module reads Chrome's accessibility tree
 * (`Accessibility.getFullAXTree`) and reduces it to a bounded semantic view:
 *
 * - page title/URL/readyState;
 * - a compact one-line summary (controls, links, landmarks, dialogs);
 * - an outline text (roles, accessible names, state) capped by a char
 *   budget with an explicit truncation marker;
 * - interactive targets with stable `eN` refs keyed to CDP backend node ids,
 *   re-resolvable at action time; stale refs fail truthfully.
 *
 * Implementation follows the approach proven by the pi-browser-harness
 * reference (AX-tree slimming, ref-by-backend-node) but is an independent
 * Aira-native implementation; no reference code is copied.
 */
import type { AiraBrowserTarget } from "../types.ts";

/** Raw AX node as returned by Accessibility.getFullAXTree. */
export interface RawAxNode {
	nodeId: string;
	parentId?: string;
	ignored?: boolean;
	role?: { value?: string | number };
	name?: { value?: string | number };
	value?: { value?: string | number };
	description?: { value?: string | number };
	properties?: Array<{ name?: string; value?: { value?: unknown } }>;
	backendDOMNodeId?: number;
	childIds?: string[];
}

export interface SlimAxNode {
	role: string;
	name?: string;
	value?: string;
	state?: string;
	children: SlimAxNode[];
	/** Provider-internal backend node id (never exposed to the model). */
	backendId?: number;
	/** Stable interaction ref assigned by the observer. */
	ref?: string;
}

/** Roles an agent can act on (refs are assigned only to these). */
export const INTERACTIVE_AX_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"combobox",
	"checkbox",
	"radio",
	"switch",
	"slider",
	"spinbutton",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"tab",
	"treeitem",
	"listbox",
	"option",
]);

/** Roles whose live value should be read from the DOM (AX value is stale). */
const _VALUE_ROLES = new Set([
	"textbox",
	"searchbox",
	"spinbutton",
	"combobox",
	"checkbox",
	"radio",
	"switch",
	"slider",
]);

const LANDMARK_ROLES = new Set([
	"banner",
	"navigation",
	"main",
	"complementary",
	"contentinfo",
	"search",
	"form",
	"region",
]);

function stringOf(value: { value?: string | number } | undefined): string | undefined {
	const v = value?.value;
	if (typeof v === "string" && v !== "") return v;
	if (typeof v === "number") return String(v);
	return undefined;
}

function collectState(properties: RawAxNode["properties"]): string | undefined {
	if (!properties) return undefined;
	const flags: string[] = [];
	for (const prop of properties) {
		const name = prop.name;
		if (!name) continue;
		const raw = prop.value?.value;
		if (
			raw === true &&
			(name === "focused" ||
				name === "required" ||
				name === "disabled" ||
				name === "checked" ||
				name === "expanded" ||
				name === "selected" ||
				name === "pressed" ||
				name === "modal")
		) {
			flags.push(name);
		}
		if (typeof raw === "number" && name === "level") flags.push(`level ${raw}`);
	}
	return flags.length > 0 ? flags.join(", ") : undefined;
}

/** Build the slim AX tree, skipping ignored nodes (children hoisted). */
export function buildSlimAxTree(rawNodes: ReadonlyArray<RawAxNode>, maxNodes: number): SlimAxNode[] {
	const byId = new Map<string, RawAxNode>();
	for (const node of rawNodes) byId.set(node.nodeId, node);
	const roots = rawNodes.filter((n) => !n.parentId || !byId.has(n.parentId));
	let budget = maxNodes;

	const slim = (node: RawAxNode): SlimAxNode | undefined => {
		if (budget <= 0) return undefined;
		if (node.ignored) {
			const out: SlimAxNode[] = [];
			for (const cid of node.childIds ?? []) {
				const child = byId.get(cid);
				if (!child) continue;
				const slimChild = slim(child);
				if (slimChild) out.push(slimChild);
			}
			if (out.length === 0) return undefined;
			return { role: "_hoist", children: out };
		}
		budget -= 1;
		const out: SlimAxNode = { role: stringOf(node.role) ?? "unknown", children: [] };
		const name = stringOf(node.name);
		const value = stringOf(node.value);
		const state = collectState(node.properties);
		if (name !== undefined) out.name = name;
		if (value !== undefined) out.value = value;
		if (state !== undefined) out.state = state;
		if (node.backendDOMNodeId !== undefined) out.backendId = node.backendDOMNodeId;
		for (const cid of node.childIds ?? []) {
			const child = byId.get(cid);
			if (!child) continue;
			const slimChild = slim(child);
			if (!slimChild) continue;
			if (slimChild.role === "_hoist") out.children.push(...slimChild.children);
			else out.children.push(slimChild);
		}
		return out;
	};

	const result: SlimAxNode[] = [];
	for (const root of roots) {
		const s = slim(root);
		if (!s) continue;
		if (s.role === "_hoist") result.push(...s.children);
		else result.push(s);
	}
	return result;
}

export function countAxNodes(nodes: ReadonlyArray<SlimAxNode>): number {
	let n = 0;
	for (const node of nodes) n += 1 + countAxNodes(node.children);
	return n;
}

/** Collect interactive targets in document order. */
export function collectInteractiveTargets(nodes: ReadonlyArray<SlimAxNode>): SlimAxNode[] {
	const out: SlimAxNode[] = [];
	const walk = (ns: ReadonlyArray<SlimAxNode>): void => {
		for (const node of ns) {
			if (node.backendId !== undefined && INTERACTIVE_AX_ROLES.has(node.role)) {
				out.push(node);
			}
			walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

/** Assign stable `eN` refs to interactive targets. */
export function assignRefs(targets: SlimAxNode[]): Map<string, number> {
	const refMap = new Map<string, number>();
	targets.forEach((node, i) => {
		const ref = `e${i + 1}`;
		node.ref = ref;
		if (node.backendId !== undefined) refMap.set(ref, node.backendId);
	});
	return refMap;
}

/**
 * Render a bounded outline: role "name" = value (state) [ref].
 * Names are capped; the budget is hard with an explicit marker.
 */
export function renderOutline(
	nodes: ReadonlyArray<SlimAxNode>,
	maxChars: number,
): { text: string; truncated: boolean } {
	const lines: string[] = [];
	const walk = (ns: ReadonlyArray<SlimAxNode>, depth: number): void => {
		for (const node of ns) {
			let line = `${"  ".repeat(depth)}${node.role}`;
			if (node.name) {
				const name = node.name.length > 80 ? `${node.name.slice(0, 79)}…` : node.name;
				line += ` "${name}"`;
			}
			if (node.value !== undefined && node.value !== node.name && node.value.length <= 120) {
				line += ` = ${JSON.stringify(node.value)}`;
			}
			if (node.state) line += ` (${node.state})`;
			if (node.ref) line += ` [${node.ref}]`;
			lines.push(line);
			if (node.children.length > 0) walk(node.children, depth + 1);
		}
	};
	walk(nodes, 0);

	const out: string[] = [];
	let used = 0;
	let truncated = false;
	for (const line of lines) {
		const cost = line.length + 1;
		if (used + cost > maxChars) {
			truncated = true;
			out.push(`[tree truncated after ${used} chars — re-observe with a larger budget for more]`);
			break;
		}
		out.push(line);
		used += cost;
	}
	return { text: out.join("\n"), truncated };
}

/** Build the one-line semantic summary from the slim tree. */
export function summarizeAxTree(
	nodes: ReadonlyArray<SlimAxNode>,
	extra: { title: string; readyState: string },
): string {
	const counts = new Map<string, number>();
	const walk = (ns: ReadonlyArray<SlimAxNode>): void => {
		for (const node of ns) {
			counts.set(node.role, (counts.get(node.role) ?? 0) + 1);
			walk(node.children);
		}
	};
	walk(nodes);

	let landmarks = 0;
	for (const [role, c] of counts) if (LANDMARK_ROLES.has(role)) landmarks += c;
	const buttons = counts.get("button") ?? 0;
	const inputs =
		(counts.get("textbox") ?? 0) +
		(counts.get("combobox") ?? 0) +
		(counts.get("checkbox") ?? 0) +
		(counts.get("radio") ?? 0) +
		(counts.get("searchbox") ?? 0);
	const links = counts.get("link") ?? 0;
	const dialogs = (counts.get("dialog") ?? 0) + (counts.get("alertdialog") ?? 0);
	const alerts = counts.get("alert") ?? 0;

	const parts: string[] = [];
	if (extra.title) parts.push(extra.title);
	else parts.push("(untitled)");
	parts.push(extra.readyState);
	if (landmarks > 0) parts.push(`${landmarks} landmark${landmarks === 1 ? "" : "s"}`);
	if (buttons > 0) parts.push(`${buttons} button${buttons === 1 ? "" : "s"}`);
	if (inputs > 0) parts.push(`${inputs} input${inputs === 1 ? "" : "s"}`);
	if (links > 0) parts.push(`${links} link${links === 1 ? "" : "s"}`);
	if (dialogs > 0) parts.push(`${dialogs} dialog${dialogs === 1 ? "" : "s"}`);
	if (alerts > 0) parts.push(`${alerts} alert${alerts === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

export type { AiraBrowserTarget };

/** Trim a target's accessible name for tool output. */
export function targetLabel(target: AiraBrowserTarget): string {
	const name = target.name ? ` "${target.name.slice(0, 60)}"` : "";
	return `${target.role}${name}`;
}
