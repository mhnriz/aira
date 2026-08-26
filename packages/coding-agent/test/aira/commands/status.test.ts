import { describe, expect, it } from "vitest";
import { buildAiraStatusReport, formatAiraStatusReport } from "../../../src/aira/commands/status.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

describe("Aira /status command", () => {
	it("builds a report from canonical state", () => {
		const state = acquireAiraSessionState("status-1", "startup");
		const report = buildAiraStatusReport(state);

		expect(report).toEqual({
			available: true,
			sessionId: "status-1",
			runtime: "active",
			mode: "build",
			project: "unresolved",
			capabilities: "core",
		});
	});

	it("reports disposed state", () => {
		const state = acquireAiraSessionState("status-2", "new");
		disposeAiraSessionState("status-2", state);
		const report = buildAiraStatusReport(state);

		expect(report.available).toBe(true);
		expect(report.runtime).toBe("disposed");
	});

	it("reports unavailability when no canonical state exists", () => {
		const report = buildAiraStatusReport(undefined);
		expect(report).toEqual({ available: false });
	});

	it("formats the minimal status output", () => {
		const state = acquireAiraSessionState("status-3", "startup");
		const text = formatAiraStatusReport(buildAiraStatusReport(state));

		expect(text).toBe(
			[
				"Aira",
				"runtime: active",
				"session: status-3",
				"mode: build",
				"project: unresolved",
				"capabilities: core",
			].join("\n"),
		);
	});

	it("formats unavailable state explicitly", () => {
		expect(formatAiraStatusReport(buildAiraStatusReport(undefined))).toBe("Aira\nstate: unavailable");
	});
});
