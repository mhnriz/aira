/**
 * Aira orchestration — child context envelope.
 *
 * A child receives ONLY an explicit context envelope: the task objective,
 * its role framing, the project root with a bounded profile summary, bounded
 * file references, bounded parent-provided context, the execution mode, and
 * the expected result contract. The parent conversation is never injected;
 * the envelope is assembled from bounded parts with hard character budgets,
 * so a delegation can never balloon into a transcript clone.
 *
 * The system prompt carries the role framing, the mode's mutation boundary
 * (PLAN children are told they are read-only, and their tool set enforces
 * it), the structured result contract, and tool discipline notes.
 */

import { airaModeLabel, buildAiraRuntimeModeEnvelope } from "../modes.ts";
import type { AiraProjectProfile } from "../project/profile.ts";
import { summarizeAiraProject } from "../project/profile.ts";
import type { AiraMode } from "../state.ts";
import { airaChildRoleOf } from "./roles.ts";
import type { AiraChildRole } from "./types.ts";

// ---------------------------------------------------------------------------
// Hard bounds (child prompts stay small; results stay small).
// ---------------------------------------------------------------------------

export const MAX_CHILD_TASK_CHARS = 4_000;
export const MAX_CHILD_FILES = 50;
export const MAX_CHILD_CONTEXT_CHARS = 8_000;
export const MAX_CHILD_SUMMARY_CHARS = 600;
export const MAX_CHILD_FINDINGS = 12;
export const MAX_CHILD_FINDING_CHARS = 300;
export const MAX_CHILD_LIST_ITEMS = 25;
export const MAX_CHILD_ITEM_CHARS = 200;

/** Bound a string to a maximum length (appending an ellipsis when truncated). */
export function boundChildText(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 1)}…`;
}

/** Bound a list of strings (cap count and per-item length). */
export function boundChildList(items: readonly string[], maxItems: number, maxItemChars: number): string[] {
	const result: string[] = [];
	for (const item of items) {
		const bounded = boundChildText(item, maxItemChars);
		if (bounded.length === 0) {
			continue;
		}
		result.push(bounded);
		if (result.length >= maxItems) {
			break;
		}
	}
	return result;
}

export interface AiraChildEnvelopeInput {
	role: AiraChildRole;
	task: string;
	mode: AiraMode;
	projectRoot: string;
	/** Bounded project profile summary (undefined when the session has none). */
	project?: AiraProjectProfile;
	files?: string[];
	context?: string;
	/** True when the child's tool set allows workspace mutation (BUILD/REVIEW implement/test). */
	mutatingAllowed: boolean;
	/** Provider/model identity that will run (telemetry; informational). */
	modelLabel?: string;
}

export interface AiraChildEnvelope {
	/** Bounded task envelope (user message). */
	prompt: string;
	/** Role-framed system prompt with the result contract. */
	systemPrompt: string;
}

/** Build the bounded child context envelope. */
export function buildAiraChildEnvelope(input: AiraChildEnvelopeInput): AiraChildEnvelope {
	const role = airaChildRoleOf(input.role);
	const roleLine = role ? `${role.label}: ${role.description}` : `Role: ${input.role}`;
	const projectLine = input.project ? summarizeAiraProject(input.project) : `root: ${input.projectRoot}`;
	const files = boundChildList(input.files ?? [], MAX_CHILD_FILES, 200);
	const context = boundChildText(input.context ?? "", MAX_CHILD_CONTEXT_CHARS);

	const sections: string[] = [
		`## Task`,
		boundChildText(input.task, MAX_CHILD_TASK_CHARS),
		``,
		`## Role`,
		roleLine,
		``,
		`## Project`,
		projectLine,
		`working directory: ${input.projectRoot}`,
	];
	if (files.length > 0) {
		sections.push(``, `## Relevant files`, ...files.map((file) => `- ${file}`));
	}
	sections.push(``, `## Execution mode`, airaModeLabel(input.mode));
	sections.push(`Control: ${buildAiraRuntimeModeEnvelope(input.mode)}`);
	if (!input.mutatingAllowed) {
		sections.push(
			``,
			`## Read-only enforcement`,
			`This child runs under read-only enforcement. You may only read, search, and inspect:`,
			`you have NO tools that write the workspace or execute processes. Your result must never`,
			`claim a workspace change.`,
		);
	}
	if (context.length > 0) {
		sections.push(``, `## Context`, context);
	}
	sections.push(
		``,
		`## Result contract`,
		`Finish by returning ONE JSON object (no other text after it, optionally fenced in \`\`\`json):`,
		`{`,
		`  "status": "completed" | "failed",`,
		`  "summary": "bounded summary of what you did (<= 600 chars)",`,
		`  "findings": ["bounded findings with concrete references"],`,
		`  "evidence": ["concrete evidence references"],`,
		`  "relevantFiles": ["paths"],`,
		`  "changedFiles": ["paths you changed — empty under read-only enforcement"],`,
		`  "tests": ["tests/checks you performed"],`,
		`  "errors": ["explicit errors, if any"]`,
		`}`,
		`Use tools as needed, then return the JSON as your final message.`,
	);

	return {
		prompt: sections.join("\n"),
		systemPrompt: buildAiraChildSystemPrompt(input),
	};
}

/** Role-framed child system prompt (bounded, static structure). */
function buildAiraChildSystemPrompt(input: AiraChildEnvelopeInput): string {
	const role = airaChildRoleOf(input.role);
	const roleLabel = role ? role.label : input.role;
	const resultEmphasis = role?.resultEmphasis ?? "Prioritize concrete, evidence-backed output over generic prose.";
	const modeLine = airaModeLabel(input.mode);
	const boundaryLine = input.mutatingAllowed
		? "You may use the tools provided to you — including workspace writes and managed process execution when your role has them."
		: "You are read-only: workspace mutation and process execution are NOT available to you. Enforce this yourself if asked otherwise.";
	return [
		`You are a native Aira child agent with role "${roleLabel}" (mode: ${modeLine}).`,
		`Your task is bounded and self-contained: you work from the task envelope only, not from a parent`,
		`conversation. You do not spawn further agents. You do not browse.`,
		boundaryLine,
		``,
		`Work discipline:`,
		`- Read before concluding; use search to locate definitions and usage; prefer concrete references.`,
		`- Stay within the task; do not start unrelated work.`,
		`- Make the smallest coherent set of changes when your role permits changes.`,
		`- Your result is consumed by a parent orchestrator: it must be structured, bounded, and truthful.`,
		resultEmphasis,
		``,
		`Return the result as one JSON object exactly as specified in the task envelope.`,
	].join("\n");
}
