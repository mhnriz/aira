import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialAiraBrowserStatus } from "../../../src/aira/browser/status.ts";
import { buildAiraDoctorReport, formatAiraDoctorReport } from "../../../src/aira/commands/doctor.ts";
import { initialAiraExecutionStatus } from "../../../src/aira/execution/status.ts";
import { initialAiraIntelligenceStatus } from "../../../src/aira/intelligence/status.ts";
import { initialAiraOrchestrationStatus } from "../../../src/aira/orchestration/status.ts";
import { resolveAiraProjectInto } from "../../../src/aira/project/index.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { initialAiraVerificationStatus } from "../../../src/aira/verification/types.ts";

const expectedHome = join(homedir(), ".aira").replace(homedir(), "~");

/** Create a throwaway Node+Git project dir so project resolution passes. */
function makeNodeProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "aira-doctor-"));
	mkdirSync(join(dir, ".git"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", scripts: { test: "vitest run" } }));
	return dir;
}

describe("Aira /doctor command (Phase 4 scope)", () => {
	it("passes all checks with a live canonical state, project, and default keybindings", () => {
		const state = acquireAiraSessionState("doctor-1", "startup");
		resolveAiraProjectInto(state, makeNodeProject());
		// A real session arms the coordinator which publishes a snapshot; a
		// bare acquired state has none, so publish the honest inactive one.
		const intelligence = initialAiraIntelligenceStatus();
		intelligence.active = false;
		intelligence.activationReason = "no defensible project (inert session state)";
		state.intelligence = intelligence;
		// A real session arms the execution runtime which publishes a snapshot;
		// a bare acquired state has none, so publish the honest inactive one.
		state.execution = initialAiraExecutionStatus();
		// A real session arms the browser runtime which publishes a snapshot;
		// a bare acquired state has none yet (probe pending is the honest
		// state before the first probe).
		state.browser = initialAiraBrowserStatus();
		// A real session arms the verification manager which publishes a snapshot;
		// a bare acquired state has none, so publish the honest idle one.
		state.verification = initialAiraVerificationStatus({
			enabled: true,
			auto: "smart",
			contextBudget: "compact",
		});
		// A real session arms the orchestration manager which publishes a
		// snapshot; a bare acquired state has none, so publish the honest idle one.
		state.orchestration = initialAiraOrchestrationStatus(true, 2);
		const report = buildAiraDoctorReport(state);

		expect(report.home).toBe(expectedHome);
		expect(report.checks.length).toBe(12);
		for (const check of report.checks) {
			expect(check.pass, `${check.name} should pass`).toBe(true);
		}
		disposeAiraSessionState("doctor-1", state);
	});

	it("reports a wiring failure when no canonical state exists", () => {
		const report = buildAiraDoctorReport(undefined);
		const sessionCheck = report.checks.find((c) => c.name === "session state");
		expect(sessionCheck?.pass).toBe(false);
		expect(sessionCheck?.detail).toContain("no canonical AiraSessionState");
	});

	it("reports an invalid mode as a session-state failure", () => {
		const state = acquireAiraSessionState("doctor-2", "startup");
		(state as { mode: string }).mode = "bogus";
		const report = buildAiraDoctorReport(state);
		const sessionCheck = report.checks.find((c) => c.name === "session state");
		expect(sessionCheck?.pass).toBe(false);
		disposeAiraSessionState("doctor-2", state);
	});

	it("verifies the mode shortcut owns Shift+Tab and thinking moved to Ctrl+Shift+E", () => {
		const state = acquireAiraSessionState("doctor-3", "startup");
		resolveAiraProjectInto(state, makeNodeProject());
		const report = buildAiraDoctorReport(state);
		const modeCheck = report.checks.find((c) => c.name === "mode shortcut");
		const thinkingCheck = report.checks.find((c) => c.name === "thinking shortcut");

		expect(modeCheck?.pass).toBe(true);
		expect(modeCheck?.detail).toContain("shift+tab");
		expect(thinkingCheck?.pass).toBe(true);
		expect(thinkingCheck?.detail).toContain("ctrl+shift+e");
		disposeAiraSessionState("doctor-3", state);
	});

	it("verifies the PLAN read-only boundary classifies tools", () => {
		const state = acquireAiraSessionState("doctor-4", "startup");
		const report = buildAiraDoctorReport(state);
		const planCheck = report.checks.find((c) => c.name === "plan read-only");

		expect(planCheck?.pass).toBe(true);
		expect(planCheck?.detail).toContain("bash");
		expect(planCheck?.detail).toContain("write");
		expect(planCheck?.detail).toContain("read");
		disposeAiraSessionState("doctor-4", state);
	});

	it("verifies the semantic capability classification contract", () => {
		const state = acquireAiraSessionState("doctor-cap", "startup");
		const report = buildAiraDoctorReport(state);
		const capCheck = report.checks.find((c) => c.name === "capabilities");

		expect(capCheck?.pass).toBe(true);
		expect(capCheck?.detail).toContain("read");
		expect(capCheck?.detail).toContain("bash");
		expect(capCheck?.detail).toContain("unknown: not flagged mutating");
		disposeAiraSessionState("doctor-cap", state);
	});

	it("flags an unresolved project as a project-awareness failure", () => {
		const state = acquireAiraSessionState("doctor-6", "startup");
		const report = buildAiraDoctorReport(state);
		const projectCheck = report.checks.find((c) => c.name === "project");

		expect(projectCheck?.pass).toBe(false);
		expect(projectCheck?.detail).toContain("not resolved");
		disposeAiraSessionState("doctor-6", state);
	});

	it("flags a missing intelligence snapshot as a wiring failure", () => {
		const state = acquireAiraSessionState("doctor-intel-1", "startup");
		const report = buildAiraDoctorReport(state);
		const check = report.checks.find((c) => c.name === "intelligence");
		expect(check?.pass).toBe(false);
		expect(check?.detail).toContain("no intelligence snapshot");
		disposeAiraSessionState("doctor-intel-1", state);
	});

	it("passes on an inactive intelligence snapshot", () => {
		const state = acquireAiraSessionState("doctor-intel-2", "startup");
		const inactive = initialAiraIntelligenceStatus();
		inactive.active = false;
		inactive.activationReason = "no defensible project";
		state.intelligence = inactive;
		const report = buildAiraDoctorReport(state);
		const check = report.checks.find((c) => c.name === "intelligence");
		expect(check?.pass).toBe(true);
		expect(check?.detail).toContain("inactive: no defensible project");
		disposeAiraSessionState("doctor-intel-2", state);
	});

	it("fails on a degraded active intelligence snapshot with detail", () => {
		const state = acquireAiraSessionState("doctor-intel-3", "startup");
		const status = initialAiraIntelligenceStatus();
		status.active = true;
		status.activationReason = "project detected";
		status.repository = {
			status: "ready",
			filesIndexed: 42,
			cacheLoaded: true,
			changesAvailable: true,
			changeCount: 2,
		};
		status.liveCode = { status: "degraded", servers: [], spawnCount: 1, crashCount: 1 };
		status.findings = { total: 3, errors: 1, warnings: 2, stale: 0 };
		status.degraded = true;
		state.intelligence = status;
		const report = buildAiraDoctorReport(state);
		const check = report.checks.find((c) => c.name === "intelligence");
		expect(check?.pass).toBe(false);
		expect(check?.detail).toContain("repository: ready");
		expect(check?.detail).toContain("live-code: degraded");
		expect(check?.detail).toContain("1 errors / 2 warnings");
		disposeAiraSessionState("doctor-intel-3", state);
	});

	it("renders a cold but resolvable live-code provider as idle", () => {
		const state = acquireAiraSessionState("doctor-intel-4", "startup");
		const status = initialAiraIntelligenceStatus();
		status.active = true;
		status.activationReason = "project detected";
		status.repository = {
			status: "ready",
			filesIndexed: 10,
			cacheLoaded: false,
			changesAvailable: false,
			changeCount: undefined,
		};
		status.liveCode = {
			status: "idle",
			servers: [{ id: "typescript", status: "unprobed", available: true }],
			spawnCount: 0,
			crashCount: 0,
		};
		status.findings = { total: 0, errors: 0, warnings: 0, stale: 0 };
		state.intelligence = status;
		const report = buildAiraDoctorReport(state);
		const check = report.checks.find((c) => c.name === "intelligence");
		expect(check?.pass).toBe(true);
		expect(check?.detail).toContain("live-code: idle (1 server(s) available)");
		disposeAiraSessionState("doctor-intel-4", state);
	});

	it("formats a human-readable report with a summary", () => {
		const state = acquireAiraSessionState("doctor-5", "startup");
		resolveAiraProjectInto(state, makeNodeProject());
		const intelligence = initialAiraIntelligenceStatus();
		intelligence.active = false;
		intelligence.activationReason = "no defensible project";
		state.intelligence = intelligence;
		state.execution = initialAiraExecutionStatus();
		state.browser = initialAiraBrowserStatus();
		state.verification = initialAiraVerificationStatus({ enabled: true, auto: "smart", contextBudget: "compact" });
		state.orchestration = initialAiraOrchestrationStatus(true, 2);
		const text = formatAiraDoctorReport(buildAiraDoctorReport(state));

		expect(text).toContain(`home: ${expectedHome}`);
		expect(text).toContain("summary: 12/12 checks passed");
		expect(text).toContain("ok  home:");
		expect(text).toContain("ok  browser: availability probe pending");
		disposeAiraSessionState("doctor-5", state);
	});

	it("flags a missing execution snapshot as a wiring failure", () => {
		const state = acquireAiraSessionState("doctor-exec-1", "startup");
		const report = buildAiraDoctorReport(state);
		const check = report.checks.find((c) => c.name === "execution");
		expect(check?.pass).toBe(false);
		expect(check?.detail).toContain("no execution snapshot");
		disposeAiraSessionState("doctor-exec-1", state);
	});

	it("reports an armed execution runtime with processes in the snapshot", () => {
		const state = acquireAiraSessionState("doctor-exec-2", "startup");
		const execution = initialAiraExecutionStatus();
		execution.active = true;
		execution.processes = [
			{
				id: "dev-1",
				purpose: "dev",
				mode: "background",
				status: "running",
				command: "npm run dev",
				cwd: "/tmp/proj",
				pid: 4242,
				createdAt: 1,
				startedAt: 1,
			},
		];
		state.execution = execution;
		const report = buildAiraDoctorReport(state);
		const check = report.checks.find((c) => c.name === "execution");
		expect(check?.pass).toBe(true);
		expect(check?.detail).toContain("1 process(es) (1 running)");
		disposeAiraSessionState("doctor-exec-2", state);
	});
});
