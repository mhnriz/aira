/**
 * Aira interaction — model-facing `ask_user` tool.
 *
 * The native structured Q&A primitive for the model: suspend execution and
 * request a bounded decision from the user. This is NOT a subagent; it is an
 * interaction primitive through the same `AiraInteractionManager` the
 * permission controller uses (kind "semantic" vs "permission" — distinct in
 * canonical state, same infrastructure).
 *
 * Guardrails baked into the tool definition:
 * - the prompt guidance tells the model to continue autonomously when the
 *   answer is inferable, and to ask only for genuine user intent,
 *   authorization, missing requirements, or unsafe assumptions;
 * - one focused question per call;
 * - cancellations are truthful: "User cancelled the question" never invents
 *   an answer; the owning operation decides how to proceed.
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
	"Use ask_user only when the decision genuinely requires the user: explicit choice, authorization, missing requirements, or an unsafe assumption. Continue autonomously when evidence makes the answer reasonably inferable.",
	"Ask exactly one focused question per ask_user call; pass a short context summary and up to 12 structured choices with brief descriptions.",
	"A cancelled or unavailable question is NOT an answer: do not invent one; state the blocker or re-ask when the decision is truly required.",
] as const;

const ASK_USER_DESCRIPTION = `Ask the user a structured question and wait for the answer.

Use ONLY when the decision genuinely requires user intent, authorization,
missing requirements, or an unsafe assumption. Continue autonomously when
the answer is reasonably inferable from evidence.

Ask exactly one focused question per call. Provide up to 12 choices with
optional descriptions (single-select by default; allowMultiple for
multi-select, allowFreeform to accept a typed answer).

The tool waits until the user answers, cancels, or the question times out.
A cancelled/unavailable question returns truthfully and is NOT an answer:
never invent one. Cases where the answer can be inferred or delayed should
not call this tool at all.`;

const askUserSchema = Type.Object({
	question: Type.String({ description: "The focused question to ask the user" }),
	context: Type.Optional(
		Type.String({ description: "Short context/reason shown before the question (summary of findings)" }),
	),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ description: "Short title for this option" }),
				description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
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
