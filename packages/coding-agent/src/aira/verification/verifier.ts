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
 * `{ driverError, failureKind }` — the manager maps it to INCONCLUSIVE with an
 * explicit `lastError`, never to PASS.
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
import { toAiraFailureEvidence } from "../orchestration/failures.ts";
import {
	type AiraRunDeadline,
	callModelStream,
	contentText,
	createAiraRunDeadline,
	hasToolCalls,
	lastBalancedObject,
	toolCallsOf,
	toolResultIsError,
	toolResultMessage,
} from "../orchestration/model-call.ts";
import type { AiraChildTokenUsage } from "../orchestration/types.ts";
import { VERIFIER_SYSTEM_PROMPT } from "./prompt.ts";
import {
	normalizeEvidenceItems,
	normalizeFindings,
	normalizeMissingEvidence,
	normalizeScopeAssessment,
	normalizeVerificationRequirements,
} from "./requirements.ts";
import type { AiraVerificationResult, AiraVerificationVerdict, AiraVerifierFailureKind } from "./types.ts";

export type { AiraVerifierFailureKind };

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
			failureKind: AiraVerifierFailureKind;
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
		return { ok: false, driverError: "no verifier model configured", failureKind: "configuration" };
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

	const deadline = createAiraRunDeadline({ timeoutMs, signal, label: "verifier" });
	const runSignal = deadline.signal;

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
		let assistant = await deadline.race(
			callModelStream(streamFn, model, VERIFIER_SYSTEM_PROMPT, messages, tools, baseOptions, runSignal),
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
						failureKind: "tool-budget",
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
				// One run -> one deadline: tool execution shares the model-call
				// deadline and receives its signal. Signal-aware tools stop at the
				// deadline; a tool that cannot be interrupted keeps running in the
				// background, but the loop stops awaiting it once the race rejects.
				const result = await deadline.race(executeVerifierTool(tools, call, runSignal));
				if (isNewToolCall && !result.isError) roundHadProgress = true;
				results.push(result);
			}
			messages.push(assistant, ...results);
			assistant = await deadline.race(
				callModelStream(streamFn, model, VERIFIER_SYSTEM_PROMPT, messages, tools, baseOptions, runSignal),
			);
			accumulateUsage(assistant);
		}
		if (hasToolCalls(assistant)) {
			return {
				ok: false,
				driverError: "verifier exceeded its read-only tool budget",
				failureKind: "tool-budget",
				toolCallsUsed,
				toolBudgetLimit,
				toolBudgetExtensions,
			};
		}
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return {
				ok: false,
				driverError: assistant.errorMessage ?? `verifier ${assistant.stopReason}`,
				failureKind: verifierStopReasonKind(deadline, assistant),
			};
		}
		const parsed = parseVerifierVerdict(contentText(assistant));
		if (!parsed) {
			return {
				ok: false,
				driverError: "verifier returned no valid structured verdict",
				failureKind: "invalid-verdict",
			};
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
		const failure = classifyVerifierThrown(error, deadline, timeoutMs);
		return {
			ok: false,
			driverError: failure.driverError,
			failureKind: failure.failureKind,
			toolCallsUsed,
			toolBudgetLimit,
			toolBudgetExtensions,
		};
	} finally {
		deadline.dispose();
	}
}

/** Map the deadline's abort source to a verifier failure kind. */
function verifierAbortKind(deadline: AiraRunDeadline): AiraVerifierFailureKind | undefined {
	if (deadline.kind === "timeout") {
		return "timeout";
	}
	if (deadline.kind === "cancelled") {
		return "cancelled";
	}
	return undefined;
}

/**
 * Classify a thrown verifier-loop error.
 *
 * The deadline records timeout vs caller cancellation explicitly, so a stream
 * that later surfaces an AbortError still lands in the correct bucket.
 * Otherwise, structured provider/tooling evidence (HTTP status, Node code, or an
 * Aira failure origin) is a provider failure; anything else is an unknown /
 * internal failure. Human detail is preserved either way.
 */
function classifyVerifierThrown(
	error: unknown,
	deadline: AiraRunDeadline,
	timeoutMs: number,
): { failureKind: AiraVerifierFailureKind; driverError: string } {
	const abort = verifierAbortKind(deadline);
	if (abort === "timeout") {
		return { failureKind: "timeout", driverError: `verifier timed out after ${timeoutMs}ms` };
	}
	if (abort === "cancelled") {
		return { failureKind: "cancelled", driverError: "verifier cancelled" };
	}
	const evidence = toAiraFailureEvidence(error, "verifier failed");
	const driverError = evidence.message ?? "verifier failed";
	if (evidence.code !== undefined || evidence.status !== undefined || evidence.origin !== undefined) {
		return { failureKind: "provider", driverError };
	}
	return { failureKind: "internal", driverError };
}

function verifierStopReasonKind(deadline: AiraRunDeadline, assistant: AssistantMessage): AiraVerifierFailureKind {
	const abort = verifierAbortKind(deadline);
	if (abort !== undefined) {
		return abort;
	}
	return assistant.stopReason === "aborted" ? "cancelled" : "provider";
}

function createVerifierTools(cwd: string): AgentTool[] {
	return [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

async function executeVerifierTool(
	tools: AgentTool[],
	call: ToolCall,
	signal?: AbortSignal,
): Promise<ToolResultMessage> {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) {
		return toolResultMessage(call, [{ type: "text", text: `Error: unknown tool ${call.name}` }], true);
	}
	try {
		const params = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const result = await tool.execute(call.id, params, signal);
		return toolResultMessage(call, result.content, toolResultIsError(result.content));
	} catch (error) {
		return toolResultMessage(
			call,
			[{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
			true,
		);
	}
}

/** Extract the structured verdict JSON from the verifier's final text. */
export function parseVerifierVerdict(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i.exec(trimmed)?.[1];
	const embedded = lastBalancedObject(trimmed);
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
