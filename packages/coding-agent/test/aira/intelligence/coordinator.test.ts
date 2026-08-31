import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decideIntelligenceActivation } from "../../../src/aira/intelligence/activation.ts";
import { buildIntelligenceContext } from "../../../src/aira/intelligence/context.ts";
import { type AiraIntelligenceHandle, createAiraIntelligence } from "../../../src/aira/intelligence/coordinator.ts";
import { AiraFindingsStore } from "../../../src/aira/intelligence/findings.ts";
import { RepositoryProvider } from "../../../src/aira/intelligence/providers/repository/index.ts";
import { type AiraProjectProfile, resolveAiraProjectInto } from "../../../src/aira/project/index.ts";
import type { AiraSessionState } from "../../../src/aira/state.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-lsp-server.mjs", import.meta.url));

const liveCodeOptions = {
	diagnosticWaitMs: 600,
	idleTimeoutMs: 30_000,
	crashCooldownMs: 0,
	launchOverrides: { typescript: { command: "node", args: [MOCK_SERVER], argv0: process.execPath } },
};

const activeHarnesses: Array<{ state: AiraSessionState; handle: AiraIntelligenceHandle }> = [];

afterEach(async () => {
	for (const entry of activeHarnesses.splice(0)) {
		await entry.handle.dispose();
		disposeAiraSessionState(entry.state.sessionId, entry.state);
	}
});

function makeProject(name: string): string {
	const root = join(tmpdir(), `aira-intel-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name, scripts: { test: "vitest run" } }));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
	mkdirSync(join(root, ".git"));
	return root;
}

function projectState(root: string): AiraSessionState {
	const state = acquireAiraSessionState(`intel-${root.split("-").at(-1)}`, "startup");
	resolveAiraProjectInto(state, root);
	return state;
}

describe("intelligence activation", () => {
	it("stays inactive without a defensible project", () => {
		const activation = decideIntelligenceActivation(undefined);
		expect(activation.active).toBe(false);
		expect(activation.reason).toContain("no defensible project");
	});

	it("activates on a detected project and lists live-code candidates", () => {
		const root = makeProject("active");
		writeFileSync(join(root, "src", "a.ts"), "export function a() {}");
		const state = projectState(root);
		const project: AiraProjectProfile = state.project!;
		const activation = decideIntelligenceActivation(project);
		expect(activation.active).toBe(true);
		expect(activation.reason).toContain("project detected");
		expect(activation.liveCodeCandidates).toContain("TypeScript");
	});

	it("flags low-confidence projects conservative (no live-code arm)", async () => {
		const root = makeProject("conservative");
		// A bare git repo without manifests is low confidence.
		const state = projectState(root);
		const activation = decideIntelligenceActivation(state.project);
		if (activation.confidence === "low") {
			expect(activation.active).toBe(true);
		}
	});
});

describe("ambient context selection", () => {
	function setup() {
		const root = makeProject("ctx");
		writeFileSync(
			join(root, "src", "tray.ts"),
			"export function stabilizeTray() {}\nexport function detectionState() {}",
		);
		writeFileSync(join(root, "src", "tray.test.ts"), "import { it } from 'vitest';");
		writeFileSync(join(root, "src", "other.ts"), "export function unrelated() {}");
		const state = projectState(root);
		const repository = new RepositoryProvider(root, { cacheDir: join(tmpdir(), "ctx-cache") });
		return { state, repository };
	}

	it("injects likely files for a free-text objective", async () => {
		const { state, repository } = setup();
		await repository.activate();
		await repository.settled();
		const activation = decideIntelligenceActivation(state.project);
		const findings = new AiraFindingsStore();
		const result = buildIntelligenceContext({
			prompt: "the detection state switches back to Not Ready after the tray stabilized",
			mode: "build",
			activation,
			projectRootName: "ctx",
			repository,
			findings,
			oriented: false,
		});
		expect(result.content).toBeDefined();
		expect(result.content).toContain("Project: ctx");
		expect(result.content).toContain("Likely files");
		expect(result.content).toContain("src/tray.ts");
		expect(result.content).toContain("detectionState");
		expect(result.content).not.toContain("src/other.ts");
	});

	it("includes changed files and diagnostics in the working-set sections", async () => {
		const { state, repository } = setup();
		await repository.activate();
		await repository.settled();
		const file = join(state.project!.root!, "src", "tray.ts");
		repository.noteEdit(file);
		const findings = new AiraFindingsStore();
		findings.replaceForPath(file, [
			{ path: file, source: "lsp", providerId: "typescript", severity: "error", message: "type mismatch" },
		]);
		const activation = decideIntelligenceActivation(state.project);
		const result = buildIntelligenceContext({
			prompt: "fix tray",
			mode: "build",
			activation,
			projectRootName: "ctx",
			repository,
			findings,
			oriented: true,
		});
		expect(result.content).toContain("Changed files");
		expect(result.content).toContain("Diagnostics: 1 error(s)");
		expect(result.content).toContain("type mismatch");
	});

	it("keeps PLAN read-only: orientation + likely files, never stale noise", async () => {
		const { state, repository } = setup();
		await repository.activate();
		await repository.settled();
		const activation = decideIntelligenceActivation(state.project);
		const findings = new AiraFindingsStore();
		const result = buildIntelligenceContext({
			prompt: "where is detection state handled?",
			mode: "plan",
			activation,
			projectRootName: "ctx",
			repository,
			findings,
			oriented: false,
		});
		expect(result.content).toContain("Project: ctx");
		expect(result.content).toContain("src/tray.ts");
	});

	it("emphasizes diagnostics, changed files, and impact in REVIEW", async () => {
		const { state, repository } = setup();
		await repository.activate();
		await repository.settled();
		const root = state.project!.root!;
		const file = join(root, "src", "tray.ts");
		repository.noteEdit(file);
		writeFileSync(join(root, "src", "usesTray.ts"), "import { stabilizeTray } from './tray';");
		writeFileSync(join(root, "src", "tray.ts"), "export function stabilizeTray() { ERROR_MARKER }");
		await repository.reindexFile(join(root, "src", "usesTray.ts"));
		await repository.reindexFile(file);
		const findings = new AiraFindingsStore();
		findings.replaceForPath(file, [
			{ path: file, source: "lsp", providerId: "typescript", severity: "error", message: "type mismatch" },
		]);
		const activation = decideIntelligenceActivation(state.project);
		const result = buildIntelligenceContext({
			prompt: "review the tray change",
			mode: "review",
			activation,
			projectRootName: "ctx",
			repository,
			findings,
			oriented: true,
		});
		expect(result.content).toContain("Changed files");
		expect(result.content).toContain("Diagnostics: 1 error(s)");
		expect(result.content).toContain("Impact (imported-by)");
		expect(result.content).toContain("imported by 1: src/usesTray.ts");
	});

	it("returns no content when nothing useful exists", () => {
		const activation = decideIntelligenceActivation(undefined);
		const result = buildIntelligenceContext({
			prompt: "hello",
			mode: "build",
			activation,
			projectRootName: undefined,
			repository: undefined,
			findings: new AiraFindingsStore(),
			oriented: true,
		});
		expect(result.content).toBeUndefined();
	});
});

describe("intelligence coordinator", () => {
	it("activates, indexes the project, and publishes health into canonical state", async () => {
		const root = makeProject("coord");
		writeFileSync(join(root, "src", "a.ts"), "export function entry() {}");
		const state = projectState(root);
		const handle = createAiraIntelligence(state, undefined, {
			cacheDir: join(tmpdir(), "coord-cache"),
			liveCodeOptions,
		});
		activeHarnesses.push({ state, handle });
		await handle.activate();
		await handle.waitUntilSettled();
		expect(state.intelligence?.active).toBe(true);
		expect(state.intelligence?.repository.status).toBe("ready");
		expect(state.intelligence?.repository.filesIndexed).toBeGreaterThan(0);
		expect(state.intelligence?.activationReason).toContain("project detected");
		// After the scan: prompt-time context resolves likely files.
		const context = handle.providePromptContext("fix the entry function");
		expect(context).toContain("src/a.ts");
	});

	it("runs the post-edit pipeline: reindex + automatic diagnostics, then surfaces them", async () => {
		const root = makeProject("postedit");
		const file = join(root, "src", "tray.ts");
		writeFileSync(file, "export function stabilizeTray() { ERROR_MARKER }");
		const state = projectState(root);
		const handle = createAiraIntelligence(state, undefined, {
			cacheDir: join(tmpdir(), "postedit-cache"),
			postEditDebounceMs: 50,
			liveCodeOptions,
		});
		activeHarnesses.push({ state, handle });
		await handle.activate();
		await handle.waitUntilSettled();

		// Simulate the host tool lifecycle around an edit.
		handle.applyAgentEvent({
			type: "tool_execution_start",
			toolCallId: "tc-1",
			toolName: "edit",
			args: { path: file },
		});
		handle.applyAgentEvent({
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName: "edit",
			result: {},
			isError: false,
		});

		// Debounce + diagnostics round trip.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(state.intelligence?.findings.errors).toBeGreaterThan(0);
		const context = handle.providePromptContext("continue fixing the tray");
		expect(context).toContain("Diagnostics");
		expect(context).toContain("ERROR_MARKER");
	});

	it("skips re-injection of identical context and stays quiet", async () => {
		const root = makeProject("quiet");
		writeFileSync(join(root, "src", "a.ts"), "export function entry() {}");
		const state = projectState(root);
		const handle = createAiraIntelligence(state, undefined, { cacheDir: join(tmpdir(), "quiet-cache") });
		activeHarnesses.push({ state, handle });
		await handle.activate();
		await handle.waitUntilSettled();
		const first = handle.providePromptContext("where is entry implemented?");
		expect(first).toBeDefined();
		// Rerun after the first injection: orientation delivered, no new signal.
		state.intelligence!.findings = { total: 0, errors: 0, warnings: 0, stale: 0, top: [] };
		const second = handle.providePromptContext("continue");
		expect(second).toBeUndefined();
	});

	it("never runs the post-edit diagnostic pipeline in PLAN", async () => {
		const root = makeProject("plan");
		const file = join(root, "src", "tray.ts");
		writeFileSync(file, "export function stabilizeTray() { ERROR_MARKER }");
		const state = projectState(root);
		state.mode = "plan";
		const handle = createAiraIntelligence(state, undefined, {
			cacheDir: join(tmpdir(), "plan-cache"),
			postEditDebounceMs: 40,
			liveCodeOptions,
		});
		activeHarnesses.push({ state, handle });
		await handle.activate();
		await handle.waitUntilSettled();
		handle.applyAgentEvent({
			type: "tool_execution_start",
			toolCallId: "tc-p",
			toolName: "write",
			args: { path: file },
		});
		handle.applyAgentEvent({
			type: "tool_execution_end",
			toolCallId: "tc-p",
			toolName: "write",
			result: {},
			isError: false,
		});
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(state.intelligence?.findings.errors).toBe(0);
		// PLAN context still works (read-only intelligence).
		const context = handle.providePromptContext("examine the tray file");
		expect(context).toContain("Project");
	});

	it("degrades gracefully with no project: everything is inert", async () => {
		const state = acquireAiraSessionState("intel-empty", "startup");
		const handle = createAiraIntelligence(state, undefined, {});
		activeHarnesses.push({ state, handle });
		await handle.activate();
		expect(state.intelligence?.active).toBe(false);
		expect(handle.providePromptContext("anything")).toBeUndefined();
		// Events are no-ops.
		handle.applyAgentEvent({
			type: "tool_execution_end",
			toolCallId: "x",
			toolName: "edit",
			result: {},
			isError: false,
		});
		expect(state.intelligence?.findings.errors).toBe(0);
	});

	it("is disposed cleanly and stops reacting afterward", async () => {
		const root = makeProject("dispose");
		writeFileSync(join(root, "src", "a.ts"), "export function a() {}");
		const state = projectState(root);
		const handle = createAiraIntelligence(state, undefined, { cacheDir: join(tmpdir(), "dispose-cache") });
		await handle.activate();
		await handle.waitUntilSettled();
		await handle.dispose();
		handle.applyAgentEvent({
			type: "tool_execution_start",
			toolCallId: "t",
			toolName: "edit",
			args: { path: join(root, "src", "a.ts") },
		});
		handle.applyAgentEvent({
			type: "tool_execution_end",
			toolCallId: "t",
			toolName: "edit",
			result: {},
			isError: false,
		});
		expect(state.intelligence?.findings.errors).toBe(0);
		disposeAiraSessionState(state.sessionId, state);
	});
});
