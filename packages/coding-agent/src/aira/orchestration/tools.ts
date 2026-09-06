/**
 * Aira orchestration — child tool-set construction.
 *
 * A child's tools derive from its role's capability classes through the
 * semantic capability tables (ADR-022) — never from tool-name string matching
 * alone. The mode gate is applied at construction: in PLAN the capability set
 * collapses to read-only + diagnostic regardless of role, so a PLAN child
 * physically cannot mutate (the scheduler additionally refuses mutation-
 * capable roles in PLAN before any child launches).
 *
 * Isolation rules:
 * - Children never receive browser tools (not auto-granted; Phase 9).
 * - Children never receive orchestration tools (root-only delegation).
 * - Children never receive unknown/extension tools (no privilege-escalation
 *   path through unclassified tools).
 * - Process-class children receive ONLY the managed execution tools, bound to
 *   the ROOT session's execution manager: child-launched processes obey the
 *   same deterministic lifecycle/cleanup as the root's (Phase 6 runtime
 *   reuse — no second process subsystem, no raw shell for children).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createEditTool } from "../../core/tools/edit.ts";
import { createFindTool } from "../../core/tools/find.ts";
import { createGrepTool } from "../../core/tools/grep.ts";
import { createLsTool } from "../../core/tools/ls.ts";
import { createReadTool } from "../../core/tools/read.ts";
import { wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import { createWriteTool } from "../../core/tools/write.ts";
import { airaCapabilityClassLabel } from "../capabilities.ts";
import { type AiraProcessToolRuntime, createAiraProcessToolDefinitions } from "../execution/tools.ts";
import type { AiraIntelligenceHandle } from "../intelligence/coordinator.ts";
import { createAiraIntelligenceToolDefinitions } from "../intelligence/model-tools.ts";
import type { AiraMode } from "../state.ts";
import { airaChildRoleOf } from "./roles.ts";
import type { AiraChildRole } from "./types.ts";

/** Tool names backed by the read-only semantic class. */
export const AIRA_CHILD_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
/** Process-class managed-execution tool names (bound to the root manager). */
export const AIRA_CHILD_PROCESS_TOOL_NAMES = [
	"process_start",
	"process_stop",
	"process_status",
	"process_logs",
] as const;

export interface AiraChildToolSetOptions {
	cwd: string;
	role: AiraChildRole;
	mode: AiraMode;
	/** Root execution manager (process tools bind to it; undefined = no process tools). */
	executionManager?: AiraProcessToolRuntime;
	/** Root intelligence coordinator shared by eligible children. */
	intelligence?: AiraIntelligenceHandle;
}

export interface AiraChildToolSet {
	tools: AgentTool[];
	/** Capability classes granted after the mode gate (telemetry). */
	capabilities: string[];
	/** True when the set includes workspace-mutating or process-executing tools. */
	mutating: boolean;
}

/** Build the mode-gated, capability-derived child tool set. */
export function buildAiraChildToolSet(options: AiraChildToolSetOptions): AiraChildToolSet {
	const role = airaChildRoleOf(options.role);
	const roleCapabilities = role?.capabilities ?? ["read-only", "diagnostic"];
	// Mode gate: PLAN collapses the set to the read-only classes (enforced at
	// construction; the scheduler separately refuses mutation roles in PLAN).
	const classes =
		options.mode === "plan"
			? roleCapabilities.filter((c) => c === "read-only" || c === "diagnostic")
			: [...roleCapabilities];

	const tools: AgentTool[] = [
		createReadTool(options.cwd),
		createGrepTool(options.cwd),
		createFindTool(options.cwd),
		createLsTool(options.cwd),
	];
	const granted = new Set<string>(AIRA_CHILD_READ_TOOL_NAMES);
	if (options.intelligence && (classes.includes("read-only") || classes.includes("diagnostic"))) {
		for (const definition of Object.values(
			createAiraIntelligenceToolDefinitions({ runtime: options.intelligence }),
		)) {
			if (!granted.has(definition.name)) {
				granted.add(definition.name);
				tools.push(wrapToolDefinition(definition));
			}
		}
	}

	if (classes.includes("mutating")) {
		for (const tool of [createWriteTool(options.cwd), createEditTool(options.cwd)]) {
			if (!granted.has(tool.name)) {
				granted.add(tool.name);
				tools.push(tool);
			}
		}
	}
	if (classes.includes("process") && options.executionManager) {
		const definitions = createAiraProcessToolDefinitions({
			manager: options.executionManager,
			state: { project: { root: options.cwd } } as never,
		});
		for (const name of AIRA_CHILD_PROCESS_TOOL_NAMES) {
			const definition = definitions[name];
			if (definition && !granted.has(name)) {
				granted.add(name);
				tools.push(wrapToolDefinition(definition));
			}
		}
	}

	const mutating = classes.includes("mutating") || classes.includes("process");
	return {
		tools,
		capabilities: classes.map((c) => airaCapabilityClassLabel(c)),
		mutating,
	};
}
