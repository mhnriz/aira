import { describe, expect, it } from "vitest";
import {
	airaCapabilityClassLabel,
	BUILTIN_READ_ONLY_CAPABILITIES,
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

	it("keeps the PLAN gate consistent with the semantic classification", () => {
		// The documented audit set (blocked in PLAN) is exactly the mutating+process classes.
		expect([...AIRA_MUTATING_TOOLS].sort()).toEqual([
			"bash",
			"edit",
			"powershell",
			"process_start",
			"process_stop",
			"write",
		]);
		for (const tool of AIRA_MUTATING_TOOLS) {
			expect(isAiraMutatingTool(tool), tool).toBe(true);
		}
		for (const tool of ["read", "grep", "find", "ls", "process_status", "process_logs"]) {
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
