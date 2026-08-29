import { describe, expect, it } from "vitest";
import {
	AIRA_MODE_CYCLE,
	AIRA_MUTATING_TOOLS,
	AIRA_READ_ONLY_TOOLS,
	airaModeGlyph,
	airaModeLabel,
	cycleAiraMode,
	isAiraModeReadOnly,
	isAiraMutatingTool,
	nextAiraMode,
	setAiraMode,
} from "../../src/aira/modes.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../src/aira/state.ts";

describe("Aira modes", () => {
	it("cycles BUILD → PLAN → REVIEW → BUILD", () => {
		const state = acquireAiraSessionState("modes-cycle", "startup");
		// default mode is build
		expect(state.mode).toBe("build");

		expect(cycleAiraMode(state)).toBe("plan");
		expect(cycleAiraMode(state)).toBe("review");
		expect(cycleAiraMode(state)).toBe("build");
		expect(cycleAiraMode(state)).toBe("plan");

		disposeAiraSessionState("modes-cycle", state);
	});

	it("nextAiraMode is pure and follows the fixed order", () => {
		expect(nextAiraMode("build")).toBe("plan");
		expect(nextAiraMode("plan")).toBe("review");
		expect(nextAiraMode("review")).toBe("build");
		expect(AIRA_MODE_CYCLE).toEqual(["build", "plan", "review"]);
	});

	it("setAiraMode writes the explicit mode to canonical state", () => {
		const state = acquireAiraSessionState("modes-set", "startup");
		expect(setAiraMode(state, "review")).toBe("review");
		expect(state.mode).toBe("review");
		expect(setAiraMode(state, "build")).toBe("build");
		expect(state.mode).toBe("build");
		disposeAiraSessionState("modes-set", state);
	});

	it("only PLAN is read-only at the policy level", () => {
		expect(isAiraModeReadOnly("build")).toBe(false);
		expect(isAiraModeReadOnly("plan")).toBe(true);
		expect(isAiraModeReadOnly("review")).toBe(false);
	});

	it("classifies built-in mutating tools (blocked in PLAN)", () => {
		for (const tool of ["bash", "powershell", "edit", "write", "process_start", "process_stop"]) {
			expect(isAiraMutatingTool(tool)).toBe(true);
		}
		// Phase 7: browser interact/lifecycle operations join the blocked set.
		for (const tool of [
			"browser_click",
			"browser_fill",
			"browser_press",
			"browser_evaluate",
			"browser_verify",
			"browser_open",
			"browser_close",
		]) {
			expect(isAiraMutatingTool(tool)).toBe(true);
		}
		expect(AIRA_MUTATING_TOOLS.size).toBe(13);
	});

	it("keeps read-only inspection tools available", () => {
		expect(AIRA_READ_ONLY_TOOLS).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"process_status",
			"process_logs",
			"browser_status",
			"browser_observe",
			"browser_wait",
			"browser_scroll",
			"browser_console",
			"browser_network",
			"browser_screenshot",
			"browser_navigate",
			"agents_delegate",
			"agents_status",
			"agents_cancel",
		]);
		for (const tool of AIRA_READ_ONLY_TOOLS) {
			expect(isAiraMutatingTool(tool)).toBe(false);
		}
	});

	it("labels and glyphs map every mode", () => {
		expect(airaModeLabel("build")).toBe("BUILD");
		expect(airaModeLabel("plan")).toBe("PLAN");
		expect(airaModeLabel("review")).toBe("REVIEW");
		expect(airaModeGlyph("build")).toBe("◈");
		expect(airaModeGlyph("plan")).toBe("◇");
		expect(airaModeGlyph("review")).toBe("◎");
	});
});
