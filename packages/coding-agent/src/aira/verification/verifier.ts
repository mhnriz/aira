/**
 * Aira verification — fresh-context verifier runner.
 *
 * Executes the verifier as an independent model invocation: a NEW context
 * (verifier system prompt + bounded evidence envelope + restricted read-only
 * tools) through the session's stream function. The implementing agent's
 * conversation is never included, which is the documented independence
 * boundary. Tools are bounded: at most `maxToolRounds` rounds of
 * read/grep/find/ls only — never a shell, never edits.
 *
 * Failure behavior: any driver failure (model/provider error, timeout,
 * cancellation, tool-budget exhaustion, unparseable verdict) yields
 * `{ driverError }` — the manager maps it to INCONCLUSIVE with an explicit
 * `lastError`, never to PASS.
 */
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { createFindTool } from "../../core/tools/find.ts";
import { createGrepTool } from "../../core/tools/grep.ts";
import { createLsTool } from "../../core/tools/ls.ts";
import { createReadTool } from "../../core/tools/read.ts";
import type { AiraChildTokenUsage } from "../orchestration/types.ts";
import { VERIFIER_SYSTEM_PROMPT } from "./prompt.ts";
import {
	normalizeEvidenceItems,
	normalizeFindings,
	normalizeMissingEvidence,
	normalizeScopeAssessment,
	normalizeVerificationRequirements,
} from "./requirements.ts";
import type { AiraVerificationResult, AiraVerificationVerdict } from "./types.ts";

export const DEFAULT_VERIFIER_TIMEOUT_MS = 180_000;
export const MAX_VERIFIER_TOOL_ROUNDS = 8;
export const MAX_VERIFIER_TOOL_CALLS_PER_ROUND = 2;
export const MAX_VERIFIER_OUTPUT_TOKENS = 1_200;
export const MAX_VERIFIER_SUMMARY_CHARS = 600;
export const MAX_VERIFIER_TOOL_EXTENSIONS = 1;
export const VERIFIER_TOOL_EXTENSION_CALLS = 4;

export interface AiraVerifierRuntime {
	model: Model<any>;
	streamFn: StreamFn;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** Structured verdict emitted by the verifier model (validated + hardened). */
export interface AiraVerifierModelVerdict {
	verdict: AiraVerificationVerdict;
	summary: string;
	requirements: AiraVerificationResult["requirements"];
	findings: AiraVerificationResult["findings"];
	evidence: AiraVerificationResult["evidence"];
	missingEvidence: string[];
	scopeAssessment: AiraVerificationResult["scopeAssessment"];
	confidence: "low" | "medium" | "high";
}

export type AiraVerifierOutcome =
	| {
			ok: true;
			verdict: AiraVerifierModelVerdict;
			tokenUsage?: AiraChildTokenUsage;
			toolCallsUsed?: number;
			toolBudgetLimit?: number;
			toolBudgetExtensions?: number;
	  }
	| {
			ok: false;
			driverError: string;
			toolCallsUsed?: number;
			toolBudgetLimit?: number;
			toolBudgetExtensions?: number;
	  };

export interface AiraVerifierOptions {
	cwd: string;
	/** Evidence envelope text (already bounded). */
	envelope: string;
	timeoutMs?: number;
	maxToolRounds?: number;
	thinkingLevel?: "off" | "low" | "medium" | "high";
}

/** Run one fresh-context verification (bounded tool loop + structured verdict). */
export async function runAiraVerifier(
	runtime: AiraVerifierRuntime,
	options: AiraVerifierOptions,
	signal?: AbortSignal,
): Promise<AiraVerifierOutcome> {
	const { model, streamFn } = runtime;
	if (!model) {
		return { ok: false, driverError: "no verifier model configured" };
	}

	const tools = createVerifierTools(options.cwd);
	const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
	const maxRounds = options.maxToolRounds ?? MAX_VERIFIER_TOOL_ROUNDS;
	let allowedRounds = maxRounds;
	let toolBudgetLimit = maxRounds * MAX_VERIFIER_TOOL_CALLS_PER_ROUND;
	let toolCallsUsed = 0;
	let toolBudgetExtensions = 0;
	const seenToolCalls = new Set<string>();
	const baseOptions: SimpleStreamOptions = {
		maxTokens: MAX_VERIFIER_OUTPUT_TOKENS,
		cacheRetention: "none",
		toolChoice: "auto",
		...(options.thinkingLevel !== undefined && options.thinkingLevel !== "off" && model.reasoning
			? { reasoning: options.thinkingLevel }
			: {}),
	};
	if (runtime.apiKey !== undefined) baseOptions.apiKey = runtime.apiKey;
	if (runtime.headers !== undefined) baseOptions.headers = runtime.headers;
	if (runtime.env !== undefined) baseOptions.env = runtime.env;

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutTimer = setTimeout(() => reject(new Error("verifier timed out")), timeoutMs);
	});

	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: options.envelope }],
			timestamp: Date.now(),
		},
	];

	let totalUsage: AiraChildTokenUsage | undefined;
	const accumulateUsage = (message: AssistantMessage): void => {
		const usage = message.usage;
		if (!usage || typeof usage.totalTokens !== "number") {
			return;
		}
		totalUsage = {
			input: (totalUsage?.input ?? 0) + (usage.input ?? 0),
			output: (totalUsage?.output ?? 0) + (usage.output ?? 0),
			cacheRead: (totalUsage?.cacheRead ?? 0) + (usage.cacheRead ?? 0),
			cacheWrite: (totalUsage?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
			total: (totalUsage?.total ?? 0) + (usage.totalTokens ?? 0),
		};
	};

	try {
		let assistant = await raceWithTimeout(
			callStream(streamFn, model, messages, tools, baseOptions, signal),
			timeout,
			signal,
		);
		accumulateUsage(assistant);
		let round = 0;
		let roundHadProgress = false;
		while (hasToolCalls(assistant)) {
			if (round >= allowedRounds) {
				if (toolBudgetExtensions >= MAX_VERIFIER_TOOL_EXTENSIONS || !roundHadProgress) {
					return {
						ok: false,
						driverError: "verifier exceeded its read-only tool budget",
						toolCallsUsed,
						toolBudgetLimit,
						toolBudgetExtensions,
					};
				}
				toolBudgetExtensions += 1;
				allowedRounds += Math.ceil(VERIFIER_TOOL_EXTENSION_CALLS / MAX_VERIFIER_TOOL_CALLS_PER_ROUND);
				toolBudgetLimit += VERIFIER_TOOL_EXTENSION_CALLS;
			}
			round += 1;
			roundHadProgress = false;
			const calls = toolCallsOf(assistant).slice(0, MAX_VERIFIER_TOOL_CALLS_PER_ROUND);
			if (calls.length === 0) {
				break;
			}
			const results: ToolResultMessage[] = [];
			for (const call of calls) {
				toolCallsUsed += 1;
				const signature = `${call.name}:${JSON.stringify(call.arguments ?? {})}`;
				const isNewToolCall = !seenToolCalls.has(signature);
				seenToolCalls.add(signature);
				const result = await executeVerifierTool(tools, call, signal);
				if (isNewToolCall && !result.isError) roundHadProgress = true;
				results.push(result);
			}
			messages.push(assistant, ...results);
			assistant = await raceWithTimeout(
				callStream(streamFn, model, messages, tools, baseOptions, signal),
				timeout,
				signal,
			);
			accumulateUsage(assistant);
		}
		if (hasToolCalls(assistant)) {
			return {
				ok: false,
				driverError: "verifier exceeded its read-only tool budget",
				toolCallsUsed,
				toolBudgetLimit,
				toolBudgetExtensions,
			};
		}
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return { ok: false, driverError: assistant.errorMessage ?? `verifier ${assistant.stopReason}` };
		}
		const parsed = parseVerifierVerdict(contentText(assistant));
		if (!parsed) {
			return { ok: false, driverError: "verifier returned no valid structured verdict" };
		}
		return {
			ok: true,
			verdict: normalizeVerifierVerdict(parsed),
			...(totalUsage !== undefined ? { tokenUsage: totalUsage } : {}),
			toolCallsUsed,
			toolBudgetLimit,
			toolBudgetExtensions,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			driverError: message === "verifier timed out" ? `verifier timed out after ${timeoutMs}ms` : message,
			toolCallsUsed,
			toolBudgetLimit,
			toolBudgetExtensions,
		};
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
	}
}

function callStream(
	streamFn: StreamFn,
	model: Model<any>,
	messages: Message[],
	tools: AgentTool[],
	options: SimpleStreamOptions,
	signal?: AbortSignal,
): Promise<AssistantMessage> {
	const maybePromise = streamFn(
		model,
		{ systemPrompt: VERIFIER_SYSTEM_PROMPT, messages, tools },
		{ ...options, signal },
	);
	return (maybePromise instanceof Promise ? maybePromise : Promise.resolve(maybePromise)).then((stream) =>
		stream.result(),
	);
}

function raceWithTimeout<T>(promise: Promise<T>, timeout: Promise<never>, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const settle = (action: () => void): void => {
			if (!settled) {
				settled = true;
				action();
			}
		};
		const onAbort = () => {
			settle(() => reject(new Error("verifier cancelled")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => settle(() => resolve(value)),
			(error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
		timeout.then(
			() => undefined,
			(error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
	});
}

function createVerifierTools(cwd: string): AgentTool[] {
	return [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

function hasToolCalls(message: AssistantMessage): boolean {
	return message.content.some((block) => (block as { type?: string }).type === "toolCall");
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => (block as { type?: string }).type === "toolCall");
}

async function executeVerifierTool(
	tools: AgentTool[],
	call: ToolCall,
	signal?: AbortSignal,
): Promise<ToolResultMessage> {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) {
		return toolResultMessage(call, [{ type: "text", text: `unknown tool ${call.name}` }], true);
	}
	try {
		const params = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const result = await tool.execute(call.id, params, signal);
		return toolResultMessage(
			call,
			result.content,
			result.content.some(
				(block) =>
					(block as { type?: string }).type === "text" && (block as { text?: string }).text?.startsWith("Error"),
			),
		);
	} catch (error) {
		return toolResultMessage(
			call,
			[{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
			true,
		);
	}
}

function toolResultMessage(call: ToolCall, content: ToolResultMessage["content"], isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		isError,
		timestamp: Date.now(),
	};
}

function contentText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** Extract the structured verdict JSON from the verifier's final text. */
export function parseVerifierVerdict(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i.exec(trimmed)?.[1];
	const objectStart = trimmed.indexOf("{");
	const objectEnd = trimmed.lastIndexOf("}");
	const embedded = objectStart >= 0 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : undefined;
	for (const candidate of [fenced, embedded, trimmed]) {
		if (!candidate) {
			continue;
		}
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// fall through to the next candidate
		}
	}
	return undefined;
}

/**
 * Normalize + harden the verifier's verdict (maestro-inspired rules):
 * - pass with unmet requirements → FAIL (actionable gaps, never a silent pass);
 * - pass with no concrete evidence list → INCONCLUSIVE;
 * - invalid/malformed verdict → INCONCLUSIVE.
 */
export function normalizeVerifierVerdict(value: Record<string, unknown>): AiraVerifierModelVerdict {
	const requirements = normalizeVerificationRequirements(value.requirements);
	const findings = normalizeFindings(value.findings);
	const evidence = normalizeEvidenceItems(value.evidence);
	const missingEvidence = normalizeMissingEvidence(value.missingEvidence);
	const scopeAssessment = normalizeScopeAssessment(value.scope);
	const confidence =
		value.confidence === "low" || value.confidence === "medium" || value.confidence === "high"
			? value.confidence
			: "low";
	const rawVerdict = value.verdict === "pass" || value.verdict === "fail" ? value.verdict : "inconclusive";
	const summary =
		typeof value.summary === "string"
			? boundSummaryText(value.summary)
			: requirements.length > 0
				? `${requirements.filter((r) => r.status === "verified").length}/${requirements.length} requirements verified`
				: "No requirements mapped.";

	let verdict: AiraVerificationVerdict = rawVerdict;
	let hardenedSummary = summary;
	const unmet = requirements.filter((r) => r.status === "unmet");
	if (verdict === "pass" && unmet.length > 0) {
		verdict = "fail";
		hardenedSummary = `Verifier reported pass but listed ${unmet.length} unmet requirement(s); treating as FAIL: ${unmet.map((r) => r.id).join(", ")}`;
	} else if (verdict === "pass" && evidence.length === 0) {
		verdict = "inconclusive";
		hardenedSummary = "Verifier claimed completion without concrete evidence; treating as INCONCLUSIVE.";
	}
	return {
		verdict,
		summary: hardenedSummary,
		requirements,
		findings,
		evidence,
		missingEvidence,
		scopeAssessment,
		confidence,
	};
}

function boundSummaryText(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= MAX_VERIFIER_SUMMARY_CHARS) {
		return trimmed;
	}
	return `${trimmed.slice(0, MAX_VERIFIER_SUMMARY_CHARS - 1)}…`;
}
