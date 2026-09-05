/** Phase 13 workspace ownership and destructive-repair guard regressions. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { AiraChangeFile } from "../../../src/aira/verification/eligibility.ts";
import {
	type AiraWorkspaceOwnershipHandle,
	createAiraWorkspaceOwnershipManager,
	isDestructiveCommand,
} from "../../../src/aira/workspace/ownership.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots.length = 0;
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "aira-ownership-"));
	mkdirSync(join(root, "src"));
	roots.push(root);
	const files = new Map<string, string>();
	const current = new Map<string, AiraChangeFile>();
	const write = (path: string, text: string, added = 1, deleted = 0): void => {
		files.set(path, text);
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
		current.set(path, { path, status: "modified", added, deleted });
	};
	const snapshot = async (): Promise<AiraChangeFile[]> => [...current.values()];
	return { root, files, current, write, snapshot };
}

function editEvent(path: string, callId = "edit-1"): [AgentEvent, AgentEvent] {
	return [
		{ type: "tool_execution_start", toolCallId: callId, toolName: "edit", args: { path } } as AgentEvent,
		{ type: "tool_execution_end", toolCallId: callId, toolName: "edit", result: {}, isError: false } as AgentEvent,
	];
}

async function begin(manager: AiraWorkspaceOwnershipHandle): Promise<void> {
	manager.beginGoal();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Aira workspace ownership", () => {
	it("protects three pre-existing dirty files during a read-only Goal and repair", async () => {
		const fx = fixture();
		fx.write("docs/phase.md", "phase work\n");
		fx.write("src/inspector.ts", "browser fix\n");
		fx.write("test/inspector.test.ts", "regression\n");
		const before = new Map(fx.files);
		const manager = createAiraWorkspaceOwnershipManager({ cwd: fx.root, snapshot: fx.snapshot });
		await begin(manager);

		const observation = await manager.classify([...fx.current.values()]);
		expect(observation.counts).toEqual({ baseline: 3, owned: 0, protected: 3, unowned: 0 });
		expect((await manager.authorizeDestructiveCommand("git restore -- docs/phase.md")).allowed).toBe(false);
		expect((await manager.authorizeDestructiveCommand("git restore -- src/inspector.ts")).reason).toContain(
			"protected pre-existing",
		);
		expect(new Map(fx.files)).toEqual(before);
	});

	it("verifies and permits repair for a Goal-owned different file while preserving baseline files", async () => {
		const fx = fixture();
		fx.write("pre-existing.txt", "keep me\n");
		const manager = createAiraWorkspaceOwnershipManager({ cwd: fx.root, snapshot: fx.snapshot });
		await begin(manager);
		fx.write("goal.txt", "bad implementation\n");
		const [start, end] = editEvent("goal.txt");
		manager.applyAgentEvent(start);
		manager.applyAgentEvent(end);
		const observation = await manager.classify([...fx.current.values()]);
		expect(observation.owned.map((file) => file.path)).toEqual(["goal.txt"]);
		expect(observation.protected.map((file) => file.path)).toEqual(["pre-existing.txt"]);
		expect((await manager.authorizeDestructiveCommand("git restore -- goal.txt")).allowed).toBe(true);
		expect((await manager.authorizeDestructiveCommand("git restore -- pre-existing.txt")).allowed).toBe(false);
	});

	it("protects a Goal edit to a path that was already dirty", async () => {
		const fx = fixture();
		fx.write("shared.txt", "user baseline\n");
		const manager = createAiraWorkspaceOwnershipManager({ cwd: fx.root, snapshot: fx.snapshot });
		await begin(manager);
		fx.write("shared.txt", "goal changed the shared file\n");
		const [start, end] = editEvent("shared.txt");
		manager.applyAgentEvent(start);
		manager.applyAgentEvent(end);
		const observation = await manager.classify([...fx.current.values()]);
		expect(observation.counts.protected).toBe(1);
		expect((await manager.authorizeDestructivePath("shared.txt")).reason).toContain("pre-existing");
	});

	it("protects an unowned external change and broad destructive commands", async () => {
		const fx = fixture();
		const manager = createAiraWorkspaceOwnershipManager({ cwd: fx.root, snapshot: fx.snapshot });
		await begin(manager);
		fx.write("external.txt", "concurrent change\n");
		const observation = await manager.classify([...fx.current.values()]);
		expect(observation.counts.unowned).toBe(1);
		expect((await manager.authorizeDestructiveCommand("rm -f external.txt")).allowed).toBe(false);
		expect((await manager.authorizeDestructiveCommand("git reset --hard")).allowed).toBe(false);
	});

	it("fails closed when the current workspace snapshot is unavailable", async () => {
		const fx = fixture();
		let available = true;
		const manager = createAiraWorkspaceOwnershipManager({
			cwd: fx.root,
			snapshot: async () => (available ? [...fx.current.values()] : undefined),
		});
		await begin(manager);
		fx.write("owned.txt", "Goal output\n");
		const [start, end] = editEvent("owned.txt");
		manager.applyAgentEvent(start);
		manager.applyAgentEvent(end);
		available = false;
		expect((await manager.authorizeDestructiveCommand("git restore -- owned.txt")).allowed).toBe(false);
	});

	it("allows bounded repair of a clean-workspace Goal-owned change", async () => {
		const fx = fixture();
		const manager = createAiraWorkspaceOwnershipManager({ cwd: fx.root, snapshot: fx.snapshot });
		await begin(manager);
		fx.write("owned.txt", "bad\n");
		const [start, end] = editEvent("owned.txt");
		manager.applyAgentEvent(start);
		manager.applyAgentEvent(end);
		expect((await manager.authorizeDestructiveCommand("git restore -- owned.txt")).allowed).toBe(true);
	});

	it("protects a previously owned path when its content drifts externally", async () => {
		const fx = fixture();
		const manager = createAiraWorkspaceOwnershipManager({ cwd: fx.root, snapshot: fx.snapshot });
		await begin(manager);
		fx.write("owned.txt", "Goal output\n");
		const [start, end] = editEvent("owned.txt");
		manager.applyAgentEvent(start);
		manager.applyAgentEvent(end);
		await manager.classify([...fx.current.values()]);
		fx.write("owned.txt", "external overwrite\n");
		const observation = await manager.classify([...fx.current.values()]);
		expect(observation.counts.protected).toBe(1);
		expect((await manager.authorizeDestructivePath("owned.txt")).allowed).toBe(false);
	});

	it("keeps a mutation observed across a repair guard refresh", async () => {
		const fx = fixture();
		const manager = createAiraWorkspaceOwnershipManager({ cwd: fx.root, snapshot: fx.snapshot });
		await begin(manager);
		fx.write("owned.txt", "first Goal output\n");
		const [firstStart, firstEnd] = editEvent("owned.txt", "first-edit");
		manager.applyAgentEvent(firstStart);
		manager.applyAgentEvent(firstEnd);
		await manager.classify([...fx.current.values()]);

		const [repairStart, repairEnd] = editEvent("owned.txt", "repair-edit");
		manager.applyAgentEvent(repairStart);
		expect((await manager.authorizeDestructivePath("owned.txt")).allowed).toBe(true);
		fx.write("owned.txt", "second Goal output\n");
		manager.applyAgentEvent(repairEnd);

		const observation = await manager.classify([...fx.current.values()]);
		expect(observation.counts).toEqual({ baseline: 0, owned: 1, protected: 0, unowned: 0 });
	});

	it("does not classify ordinary commands as destructive", () => {
		expect(isDestructiveCommand("git status --short")).toBe(false);
		expect(isDestructiveCommand("git restore -- src/a.ts")).toBe(true);
		expect(isDestructiveCommand("rm -f src/a.ts")).toBe(true);
	});

	it("protects the pre-existing dogfood files byte-for-byte after refused repair", async () => {
		const fx = fixture();
		fx.write("phase-report.md", "pre-existing report\n");
		fx.write("interactive-mode.ts", "pre-existing browser fix\n");
		fx.write("agent-inspector.test.ts", "pre-existing regression\n");
		const before = ["phase-report.md", "interactive-mode.ts", "agent-inspector.test.ts"].map((path) =>
			readFileSync(join(fx.root, path), "utf8"),
		);
		const manager = createAiraWorkspaceOwnershipManager({ cwd: fx.root, snapshot: fx.snapshot });
		await begin(manager);
		const command = "git restore -- phase-report.md interactive-mode.ts agent-inspector.test.ts";
		expect((await manager.authorizeDestructiveCommand(command)).allowed).toBe(false);
		expect(
			["phase-report.md", "interactive-mode.ts", "agent-inspector.test.ts"].map((path) =>
				readFileSync(join(fx.root, path), "utf8"),
			),
		).toEqual(before);
	});
});
