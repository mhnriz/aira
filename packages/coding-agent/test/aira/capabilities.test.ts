import { describe, expect, it } from "vitest";
import {
	airaCapabilityClassLabel,
	BUILTIN_READ_ONLY_CAPABILITIES,
	classifyAiraBrowserOperation,
	classifyAiraCapability,
	isAiraCapabilityReadOnly,
	isAiraMutatingCapability,
} from "../../src/aira/capabilities.ts";
import { AIRA_MUTATING_TOOLS, isAiraMutatingTool } from "../../src/aira/modes.ts";

describe("Aira capability classification (native semantic contract)", () => {
	it("classifies the built-in read-only tools as read-only", () => {
		for (const tool of ["read", "grep", "find", "ls"]) {
			expect(classifyAiraCapability(tool), tool).toBe("read-only");
			expect(isAiraCapabilityReadOnly(tool), tool).toBe(true);
		}
	});

	it("classifies the workspace-mutating tools as mutating", () => {
		for (const tool of ["edit", "write"]) {
			expect(classifyAiraCapability(tool), tool).toBe("mutating");
		}
	});

	it("classifies the process/execution tools as process (PLAN-mutating)", () => {
		for (const tool of ["bash", "powershell"]) {
			expect(classifyAiraCapability(tool), tool).toBe("process");
			expect(isAiraMutatingCapability(tool), tool).toBe(true);
			expect(isAiraCapabilityReadOnly(tool), tool).toBe(false);
		}
	});

	it("classifies the native process runtime tools (Phase 6)", () => {
		// Launch/stop are process (PLAN-blocked); inspection/logs are
		// diagnostic (safe in read-only contexts).
		for (const tool of ["process_start", "process_stop"]) {
			expect(classifyAiraCapability(tool), tool).toBe("process");
			expect(isAiraMutatingCapability(tool), tool).toBe(true);
			expect(isAiraCapabilityReadOnly(tool), tool).toBe(false);
		}
		for (const tool of ["process_status", "process_logs"]) {
			expect(classifyAiraCapability(tool), tool).toBe("diagnostic");
			expect(isAiraMutatingCapability(tool), tool).toBe(false);
			expect(isAiraCapabilityReadOnly(tool), tool).toBe(true);
		}
	});

	it("leaves third-party/unknown tools unclassified and PLAN-permissive", () => {
		expect(classifyAiraCapability("some-extension-tool")).toBe("unknown");
		expect(classifyAiraCapability("lens_diagnostics")).toBe("unknown");
		expect(isAiraMutatingCapability("some-extension-tool")).toBe(false);
		expect(isAiraCapabilityReadOnly("some-extension-tool")).toBe(false);
	});

	it("classifies the native browser tools (Phase 7)", () => {
		// Browser tools classify as "browser"; the operation kind decides the
		// PLAN surface: observation/navigation stay read-only-safe,
		// interact/lifecycle are blocked there.
		expect(classifyAiraCapability("browser_observe")).toBe("browser");
		expect(classifyAiraCapability("browser_click")).toBe("browser");
		for (const tool of [
			"browser_status",
			"browser_observe",
			"browser_wait",
			"browser_scroll",
			"browser_console",
			"browser_network",
			"browser_screenshot",
		]) {
			expect(classifyAiraBrowserOperation(tool), tool).toBe("observe");
			expect(isAiraMutatingTool(tool), tool).toBe(false);
		}
		expect(classifyAiraBrowserOperation("browser_navigate")).toBe("navigate");
		expect(isAiraMutatingTool("browser_navigate")).toBe(false);
		for (const tool of ["browser_click", "browser_fill", "browser_press", "browser_evaluate", "browser_verify"]) {
			expect(classifyAiraBrowserOperation(tool), tool).toBe("interact");
			expect(isAiraMutatingTool(tool), tool).toBe(true);
		}
		for (const tool of ["browser_open", "browser_close"]) {
			expect(classifyAiraBrowserOperation(tool), tool).toBe("lifecycle");
			expect(isAiraMutatingTool(tool), tool).toBe(true);
		}
	});

	it("keeps the PLAN gate consistent with the semantic classification", () => {
		// The documented audit set (blocked in PLAN) is the mutating+process
		// classes plus the browser interact/lifecycle surface (Phase 7).
		expect([...AIRA_MUTATING_TOOLS].sort()).toEqual([
			"bash",
			"browser_click",
			"browser_close",
			"browser_evaluate",
			"browser_fill",
			"browser_open",
			"browser_press",
			"browser_verify",
			"edit",
			"powershell",
			"process_start",
			"process_stop",
			"write",
		]);
		for (const tool of AIRA_MUTATING_TOOLS) {
			expect(isAiraMutatingTool(tool), tool).toBe(true);
		}
		for (const tool of [
			"read",
			"grep",
			"find",
			"ls",
			"process_status",
			"process_logs",
			"browser_observe",
			"browser_navigate",
			"browser_status",
		]) {
			expect(isAiraMutatingTool(tool), tool).toBe(false);
		}
	});

	it("exposes the built-in read-only capability list for PLAN availability", () => {
		expect([...BUILTIN_READ_ONLY_CAPABILITIES].sort()).toEqual([
			"find",
			"grep",
			"ls",
			"process_logs",
			"process_status",
			"read",
		]);
		expect(BUILTIN_READ_ONLY_CAPABILITIES.includes("process_start")).toBe(false);
		expect(BUILTIN_READ_ONLY_CAPABILITIES.includes("process_stop")).toBe(false);
	});

	it("renders a human label for every class", () => {
		expect(airaCapabilityClassLabel("mutating")).toBe("mutating");
		expect(airaCapabilityClassLabel("diagnostic")).toBe("diagnostic");
		expect(airaCapabilityClassLabel("unknown")).toBe("unknown");
	});
});
