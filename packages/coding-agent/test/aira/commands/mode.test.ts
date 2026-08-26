import { describe, expect, it } from "vitest";
import { buildAiraModeReport, formatAiraModeReport, parseAiraModeArg } from "../../../src/aira/commands/mode.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

describe("Aira /mode command", () => {
	it("builds a report from canonical state", () => {
		const state = acquireAiraSessionState("mode-1", "startup");
		const report = buildAiraModeReport(state);

		expect(report).toEqual({ available: true, mode: "build", label: "BUILD", readOnly: false, next: "plan" });
		disposeAiraSessionState("mode-1", state);
	});

	it("reports PLAN as read-only", () => {
		const state = acquireAiraSessionState("mode-2", "startup");
		state.mode = "plan";
		const report = buildAiraModeReport(state);

		expect(report.readOnly).toBe(true);
		expect(report.next).toBe("review");
		disposeAiraSessionState("mode-2", state);
	});

	it("reports unavailable without canonical state", () => {
		expect(buildAiraModeReport(undefined)).toEqual({ available: false });
	});

	it("formats the report with the cycle hint", () => {
		const state = acquireAiraSessionState("mode-3", "startup");
		state.mode = "review";
		const text = formatAiraModeReport(buildAiraModeReport(state));

		expect(text).toBe(["mode: REVIEW", "next: BUILD", "Shift+Tab cycles BUILD → PLAN → REVIEW"].join("\n"));
		disposeAiraSessionState("mode-3", state);
	});

	it("parses /mode arguments", () => {
		expect(parseAiraModeArg(undefined)).toBeUndefined();
		expect(parseAiraModeArg("")).toBeUndefined();
		expect(parseAiraModeArg("build")).toBe("build");
		expect(parseAiraModeArg("plan")).toBe("plan");
		expect(parseAiraModeArg("review")).toBe("review");
		expect(parseAiraModeArg("cycle")).toBe("cycle");
		expect(parseAiraModeArg("next")).toBe("cycle");
		expect(parseAiraModeArg("bogus")).toBeUndefined();
	});
});
