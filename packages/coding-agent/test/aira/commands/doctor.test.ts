import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAiraDoctorReport, formatAiraDoctorReport } from "../../../src/aira/commands/doctor.ts";
import { resolveAiraProjectInto } from "../../../src/aira/project/index.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

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
		const report = buildAiraDoctorReport(state);

		expect(report.home).toBe(expectedHome);
		expect(report.checks.length).toBe(6);
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

	it("flags an unresolved project as a project-awareness failure", () => {
		const state = acquireAiraSessionState("doctor-6", "startup");
		const report = buildAiraDoctorReport(state);
		const projectCheck = report.checks.find((c) => c.name === "project");

		expect(projectCheck?.pass).toBe(false);
		expect(projectCheck?.detail).toContain("not resolved");
		disposeAiraSessionState("doctor-6", state);
	});

	it("formats a human-readable report with a summary", () => {
		const state = acquireAiraSessionState("doctor-5", "startup");
		resolveAiraProjectInto(state, makeNodeProject());
		const text = formatAiraDoctorReport(buildAiraDoctorReport(state));

		expect(text).toContain(`home: ${expectedHome}`);
		expect(text).toContain("summary: 6/6 checks passed");
		expect(text).toContain("ok  home:");
		disposeAiraSessionState("doctor-5", state);
	});
});
