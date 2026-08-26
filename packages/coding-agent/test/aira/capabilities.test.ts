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

	it("leaves third-party/unknown tools unclassified and PLAN-permissive", () => {
		expect(classifyAiraCapability("some-extension-tool")).toBe("unknown");
		expect(classifyAiraCapability("lens_diagnostics")).toBe("unknown");
		expect(isAiraMutatingCapability("some-extension-tool")).toBe(false);
		expect(isAiraCapabilityReadOnly("some-extension-tool")).toBe(false);
	});

	it("keeps the PLAN gate consistent with the semantic classification", () => {
		// The documented audit set (blocked in PLAN) is exactly the mutating+process classes.
		expect([...AIRA_MUTATING_TOOLS].sort()).toEqual(["bash", "edit", "powershell", "write"]);
		for (const tool of AIRA_MUTATING_TOOLS) {
			expect(isAiraMutatingTool(tool), tool).toBe(true);
		}
		for (const tool of ["read", "grep", "find", "ls"]) {
			expect(isAiraMutatingTool(tool), tool).toBe(false);
		}
	});

	it("exposes the built-in read-only capability list for PLAN availability", () => {
		expect([...BUILTIN_READ_ONLY_CAPABILITIES].sort()).toEqual(["find", "grep", "ls", "read"]);
	});

	it("renders a human label for every class", () => {
		expect(airaCapabilityClassLabel("mutating")).toBe("mutating");
		expect(airaCapabilityClassLabel("diagnostic")).toBe("diagnostic");
		expect(airaCapabilityClassLabel("unknown")).toBe("unknown");
	});
});
