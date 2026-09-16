/**
 * Aira interaction — model-facing `ask_user` tool.
 *
 * The native structured Q&A primitive for the model: suspend execution and
 * request a bounded decision from the user. This is NOT a subagent; it is an
 * interaction primitive through the same `AiraInteractionManager` the
 * permission controller uses (kind "semantic" vs "permission" — distinct in
 * canonical state, same infrastructure).
 *
 * Guardrails baked into the tool definition (0.1.7 step 5): the guidance is
 * a decision-boundary policy, not an uncertainty escape hatch.
 *
 * - repository-resolvable uncertainty (which file, which convention, which
 *   framework, whether a dependency exists) is investigated, not asked;
 * - routine reversible implementation choices proceed without asking;
 * - ask only when materially different outcomes remain and the user owns the
 *   decision: product/UX direction, architecture trade-offs, destructive or
 *   irreversible actions, authorization, or facts only the user can know;
 * - an explicit user decision is never re-asked, even against repo
 *   convention;
 * - investigation stops when it no longer improves confidence: with two or
 *   more materially different options left, ask instead of searching again;
 * - one focused question per call, concise options with consequences, and a
 *   recommended default when evidence supports one;
 * - cancellations are truthful: "User cancelled the question" never invents
 *   an answer; the owning operation decides how to proceed.
 *
 * The policy stays guidance-level on purpose: the model weighs the evidence
 * locally, with no hidden classifier call and no numeric confidence scoring.
 *
 * Headless sessions (no interactive UI bridge) resolve as "unavailable":
 * the question was NOT shown, the model is told so, and the run continues.
 */
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { AiraInteractionAnswer, AiraInteractionRequest } from "./types.ts";

/** The slice of the interaction manager the tool needs. */
export interface AiraInteractionToolRuntime {
	ask(request: AiraInteractionRequest, signal?: AbortSignal): Promise<AiraInteractionAnswer>;
}

const ASK_USER_PROMPT_SNIPPET = "Ask the user one focused question and wait for the answer";

const ASK_USER_PROMPT_GUIDELINES = [
	"Use ask_user only at a genuine decision boundary: investigate first when the repository or environment can answer, and proceed on routine reversible choices.",
	"Ask when materially different outcomes remain: user-owned product/UX direction, architecture trade-offs, destructive or irreversible actions, or facts only the user can supply. Never re-ask what the user already decided explicitly.",
	"Ask exactly one concrete question with concise options and a recommended default; a cancelled or unavailable question is not an answer, so state the blocker or re-ask when the decision is truly required.",
] as const;

const ASK_USER_DESCRIPTION = `Ask the user a structured question and wait for the answer.

Decision boundary, not an uncertainty escape: ask only when the decision
genuinely needs the user — product/UX direction, architecture trade-offs,
destructive or irreversible actions, authorization, missing requirements, or
facts only the user can know. Investigate first when the repository or
environment can answer the question, and proceed on reversible choices;
never re-ask what the user already decided.

Ask exactly one concrete question per call. Provide up to 12 choices with
brief consequences (single-select by default; allowMultiple for
multi-select, allowFreeform to accept a typed answer), and recommend a
default when evidence supports one. Do not dump internal investigation
detail into the question.

The tool waits until the user answers, cancels, or the question times out.
A cancelled/unavailable question returns truthfully and is NOT an answer:
never invent one.`;

const askUserSchema = Type.Object({
	question: Type.String({ description: "The focused question to ask the user" }),
	context: Type.Optional(
		Type.String({ description: "Short context/reason shown before the question (summary of findings)" }),
	),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ description: "Short title for this option" }),
				description: Type.Optional(Type.String({ description: "Brief consequence of choosing this option" })),
			}),
			{ description: "Up to 12 structured choices" },
		),
	),
	allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default false)" })),
	allowFreeform: Type.Optional(Type.Boolean({ description: "Accept a typed freeform answer (default true)" })),
});

type AskUserParams = Static<typeof askUserSchema>;

/** Create the `ask_user` tool bound to a session's interaction manager. */
export function createAiraInteractionToolDefinitions(options: {
	runtime: AiraInteractionToolRuntime;
}): Record<string, ToolDefinition> {
	const { runtime } = options;
	return {
		ask_user: {
			name: "ask_user",
			label: "ask user",
			description: ASK_USER_DESCRIPTION,
			promptSnippet: ASK_USER_PROMPT_SNIPPET,
			promptGuidelines: [...ASK_USER_PROMPT_GUIDELINES],
			parameters: askUserSchema,
			async execute(_toolCallId, params: AskUserParams, signal) {
				const options = Array.isArray(params.options)
					? params.options.slice(0, 12).map((option, index) => ({
							id: `o${index + 1}`,
							label: String(option?.title ?? "").trim() || `Option ${index + 1}`,
							...(option?.description ? { description: String(option.description).trim() } : {}),
						}))
					: [];
				const answer = await runtime.ask(
					{
						type: "semantic",
						question: String(params.question ?? ""),
						...(params.context ? { context: String(params.context) } : {}),
						...(options.length > 0 ? { choices: options } : {}),
						...(params.allowMultiple === true && options.length > 0 ? { multiSelect: true } : {}),
						...(params.allowFreeform !== false ? { freeform: true } : {}),
						owner: "agent",
					},
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text: renderAskUserOutcome(answer, options),
						},
					],
					details: {
						interactionId: answer.interactionId,
						resolution: answer.resolution,
						selections: answer.selections,
						...(answer.text !== undefined ? { text: answer.text } : {}),
					},
				};
			},
		},
	};
}

function renderAskUserOutcome(
	answer: AiraInteractionAnswer,
	options: Array<{ id: string; label: string; description?: string }>,
): string {
	switch (answer.resolution) {
		case "answered": {
			const parts: string[] = [];
			if (answer.selections.length > 0) {
				const labels = options
					.filter((option) => answer.selections.includes(option.id))
					.map((option) => option.label);
				parts.push(labels.length > 0 ? labels.join(", ") : `choices ${answer.selections.join(", ")}`);
			}
			if (answer.text) {
				parts.push(answer.text);
			}
			return `User answered: ${parts.length > 0 ? parts.join(" — ") : "(empty)"}`;
		}
		case "cancelled":
			return "User cancelled the question. This is NOT an answer: do not invent one. State the blocker or re-ask when the decision is truly required.";
		case "timed-out":
			return "The question timed out without an answer. This is NOT an answer: do not invent one; proceed only on evidence or state the blocker.";
		case "superseded":
			return "The question was superseded by another pending question and was not shown. Do not invent an answer; state the blocker or re-ask later.";
		default:
			return "No interactive UI is available, so the question was NOT asked. This is NOT an answer: do not invent one; proceed only on evidence or state the blocker.";
	}
}
