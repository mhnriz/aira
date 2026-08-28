/**
 * Phase 7 — semantic observation (AX tree) tests.
 *
 * Pure functions: tree slimming, bounded outline rendering with explicit
 * truncation markers, interactive ref assignment, summary lines.
 */
import { describe, expect, it } from "vitest";
import {
	assignRefs,
	buildSlimAxTree,
	collectInteractiveTargets,
	countAxNodes,
	type RawAxNode,
	renderOutline,
	summarizeAxTree,
} from "../../../src/aira/browser/cdp/observe.ts";

function axNode(overrides: Partial<RawAxNode> & { nodeId: string }): RawAxNode {
	return { role: { value: "generic" }, childIds: [], ...overrides };
}

describe("Phase 7 — semantic observation (AX tree)", () => {
	it("builds a slim tree and assigns stable refs to interactive targets only", () => {
		const raw: RawAxNode[] = [
			axNode({
				nodeId: "1",
				role: { value: "rootWebArea" },
				name: { value: "player" },
				childIds: ["2", "3", "4", "5"],
			}),
			axNode({
				nodeId: "2",
				parentId: "1",
				role: { value: "heading" },
				name: { value: "Now Playing" },
				backendDOMNodeId: 100,
				childIds: [],
			}),
			axNode({
				nodeId: "3",
				parentId: "1",
				role: { value: "button" },
				name: { value: "Play" },
				backendDOMNodeId: 101,
				childIds: [],
			}),
			axNode({
				nodeId: "4",
				parentId: "1",
				role: { value: "textbox" },
				name: { value: "Search" },
				backendDOMNodeId: 102,
				childIds: [],
			}),
			axNode({ nodeId: "5", parentId: "1", role: { value: "paragraph" }, childIds: [] }),
		];
		const slim = buildSlimAxTree(raw, 100);
		expect(countAxNodes(slim)).toBe(5);

		const targets = collectInteractiveTargets(slim);
		expect(targets.map((t) => t.role).sort()).toEqual(["button", "textbox"]);
		const refMap = assignRefs(targets);
		expect([...refMap.keys()]).toEqual(["e1", "e2"]);
		expect(refMap.get("e1")).toBe(101);
		expect(refMap.get("e2")).toBe(102);
	});

	it("skips ignored nodes but hoists their meaningful children", () => {
		const raw: RawAxNode[] = [
			axNode({ nodeId: "1", role: { value: "rootWebArea" }, childIds: ["2"] }),
			axNode({ nodeId: "2", parentId: "1", ignored: true, childIds: ["3"] }),
			axNode({
				nodeId: "3",
				parentId: "2",
				role: { value: "button" },
				name: { value: "Go" },
				backendDOMNodeId: 200,
				childIds: [],
			}),
		];
		const slim = buildSlimAxTree(raw, 100);
		expect(countAxNodes(slim)).toBe(2); // rootWebArea + button (wrapper hoisted away)
		const targets = collectInteractiveTargets(slim);
		expect(targets.length).toBe(1);
		expect(targets[0]!.name).toBe("Go");
	});

	it("bounds the tree by node budget with a truncation marker", () => {
		const raw: RawAxNode[] = [
			axNode({ nodeId: "1", role: { value: "rootWebArea" }, childIds: [] }),
			...Array.from({ length: 20 }, (_, i) =>
				axNode({ nodeId: `w${i}`, role: { value: "generic" }, name: { value: `wrapper-${i}` }, childIds: [] }),
			),
		];
		const slim = buildSlimAxTree(raw, 5);
		expect(countAxNodes(slim)).toBeLessThanOrEqual(5);
	});

	it("renders a bounded outline with explicit truncation", () => {
		const nodes = [
			{ role: "button", name: "Play", state: "focused", ref: "e1", children: [] },
			{ role: "textbox", name: "Search", value: "abc", ref: "e2", children: [] },
			{ role: "generic", children: [{ role: "link", name: "Docs", ref: "e3", children: [] }] },
		];
		const full = renderOutline(nodes as never, 2000);
		expect(full.truncated).toBe(false);
		expect(full.text).toContain(`button "Play" (focused) [e1]`);
		expect(full.text).toContain(`textbox "Search" = "abc" [e2]`);
		expect(full.text).toContain(`link "Docs" [e3]`);

		const tiny = renderOutline(nodes as never, 30);
		expect(tiny.truncated).toBe(true);
		expect(tiny.text).toContain("[tree truncated");
	});

	it("caps long accessible names in the outline", () => {
		const nodes = [{ role: "button", name: "x".repeat(200), children: [] }];
		const rendered = renderOutline(nodes as never, 5000);
		expect(rendered.text.length).toBeLessThan(120);
	});

	it("produces a compact one-line summary", () => {
		const nodes = [
			{
				role: "main",
				children: [
					{ role: "heading", name: "Player", children: [] },
					{ role: "button", name: "Play", children: [] },
					{ role: "button", name: "Pause", children: [] },
					{ role: "textbox", name: "Search", children: [] },
					{ role: "link", name: "Docs", children: [] },
				],
			},
			{ role: "dialog", name: "Confirm", children: [] },
		];
		const summary = summarizeAxTree(nodes as never, { title: "player", readyState: "complete" });
		expect(summary).toContain("player");
		expect(summary).toContain("complete");
		expect(summary).toContain("2 buttons");
		expect(summary).toContain("1 input");
		expect(summary).toContain("1 link");
		expect(summary).toContain("1 landmark");
		expect(summary).toContain("1 dialog");
	});
});
