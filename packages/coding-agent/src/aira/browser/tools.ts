/**
 * Aira browser — model-facing tools.
 *
 * A restrained set of coherent browser operations (not dozens of tiny
 * overlapping tools). The browser is Aira-owned and isolated: these tools
 * drive the session's browser manager, which publishes bounded evidence into
 * canonical state. Results are structured and truthful — stale refs, missing
 * browsers, and timeouts return typed reasons with fresh page state, never
 * opaque provider exceptions.
 *
 * Capability semantics (ADR-022/ADR-025): `browser_*` classify as `browser`
 * with a semantic operation kind (observe | navigate | interact | lifecycle).
 * PLAN blocks interact + lifecycle tools (the read-only boundary holds) and
 * keeps observation + navigation available.
 */

import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, str } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { AiraBrowserHandle } from "./manager.ts";
import { type AiraBrowserManagerOpenOptions, AiraBrowserNotOpenError } from "./manager.ts";
import type { AiraBrowserClickOptions, AiraBrowserNavigateOptions, AiraBrowserObserveOptions } from "./provider.ts";
import type { AiraBrowserStatus } from "./status.ts";
import type {
	AiraBrowserChange,
	AiraBrowserConsoleRecord,
	AiraBrowserEvidenceDrain,
	AiraBrowserNetworkRecord,
	AiraBrowserObservation,
	AiraBrowserOperationResult,
	AiraBrowserWaitCondition,
} from "./types.ts";

export interface AiraBrowserToolContext {
	runtime: AiraBrowserHandle;
}

const browserOpenSchema = Type.Object({
	url: Type.Optional(
		Type.String({
			description:
				"Initial URL (prefer http://localhost or http://127.0.0.1 — the Aira browser is an isolated profile and local verification is the default use).",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Navigation timeout in seconds (default 30)." })),
});

const browserStatusSchema = Type.Object({});

const browserObserveSchema = Type.Object({
	tab: Type.Optional(Type.String({ description: "Tab id (default: active tab)." })),
	maxNodes: Type.Optional(
		Type.Integer({
			minimum: 50,
			maximum: 2000,
			description: "Cap on semantic tree nodes (default 400).",
		}),
	),
	maxChars: Type.Optional(
		Type.Integer({
			minimum: 500,
			maximum: 20000,
			description: "Outline character budget (default 4000; truncated with a marker).",
		}),
	),
});

const browserNavigateSchema = Type.Object({
	url: Type.String({ description: "URL to navigate to." }),
	waitUntil: Type.Optional(
		Type.Union([Type.Literal("commit"), Type.Literal("domcontentloaded"), Type.Literal("load")], {
			description: "What to wait for (default domcontentloaded).",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30)." })),
});

const browserClickSchema = Type.Object({
	ref: Type.Optional(
		Type.String({
			description: "Stable element ref from browser_observe (e.g. 'e12'). Preferred over coordinates.",
		}),
	),
	x: Type.Optional(Type.Number({ description: "Fallback viewport x (CSS px) when no ref." })),
	y: Type.Optional(Type.Number({ description: "Fallback viewport y (CSS px) when no ref." })),
	button: Type.Optional(
		Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
			description: "Mouse button (default left).",
		}),
	),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "Click count (1-3, default 1)." })),
});

const browserFillSchema = Type.Object({
	ref: Type.String({ description: "Stable element ref from browser_observe." }),
	value: Type.Union([Type.String(), Type.Boolean()], {
		description:
			"Value to write. Text inputs, textareas, contenteditable, selects, checkboxes, and radios are supported.",
	}),
});

const browserPressSchema = Type.Object({
	key: Type.String({
		description:
			"Key to press: Enter, Tab, Backspace, Delete, Escape, ArrowLeft/Up/Right/Down, Home, End, PageUp, PageDown, or any character.",
	}),
	modifiers: Type.Optional(
		Type.Integer({
			description: "Modifier bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift; combine with OR.",
		}),
	),
});

const browserScrollSchema = Type.Object({
	ref: Type.Optional(Type.String({ description: "Scroll at this element (defaults to viewport center)." })),
	deltaX: Type.Optional(Type.Integer({ description: "Horizontal wheel delta (CSS px, default 0)." })),
	deltaY: Type.Optional(Type.Integer({ description: "Vertical wheel delta (CSS px, default 300)." })),
});

const browserWaitSchema = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("selector"),
				Type.Literal("text"),
				Type.Literal("url"),
				Type.Literal("ready"),
				Type.Literal("time"),
			],
			{ description: "What to wait for (default selector)." },
		),
	),
	selector: Type.Optional(Type.String({ description: "CSS selector for kind=selector." })),
	text: Type.Optional(Type.String({ description: "Visible text for kind=text." })),
	substring: Type.Optional(Type.String({ description: "URL substring for kind=url." })),
	readyState: Type.Optional(
		Type.Union([Type.Literal("interactive"), Type.Literal("complete")], { description: "For kind=ready." }),
	),
	ms: Type.Optional(Type.Integer({ description: "Milliseconds for kind=time." })),
	timeout: Type.Optional(Type.Number({ description: "Max wait in seconds (default 10)." })),
});

const browserEvaluateSchema = Type.Object({
	expression: Type.String({
		description:
			"Page expression (runs in the page's main world, returnByValue). Keep it small and read-only; the result is summarized.",
	}),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 10)." })),
});

const browserConsoleSchema = Type.Object({
	levels: Type.Optional(
		Type.Array(
			Type.Union([
				Type.Literal("error"),
				Type.Literal("warn"),
				Type.Literal("info"),
				Type.Literal("debug"),
				Type.Literal("log"),
			]),
			{ description: "Level filter (default all)." },
		),
	),
	sinceSeq: Type.Optional(Type.Integer({ description: "Only records after this sequence (drain cursor)." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max records (default 100)." })),
});

const browserNetworkSchema = Type.Object({
	sinceSeq: Type.Optional(Type.Integer({ description: "Only failures after this sequence (drain cursor)." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max records (default 100)." })),
});

const browserScreenshotSchema = Type.Object({});

const browserVerifySchema = Type.Object({
	url: Type.Optional(
		Type.String({
			description: "Local URL to verify (default: discovered from the running dev process).",
		}),
	),
});

const browserCloseSchema = Type.Object({
	tab: Type.Optional(
		Type.String({
			description: "Close only this tab id; omit to close the whole Aira browser session.",
		}),
	),
});

export type BrowserOpenToolInput = Static<typeof browserOpenSchema>;
export type BrowserObserveToolInput = Static<typeof browserObserveSchema>;
export type BrowserNavigateToolInput = Static<typeof browserNavigateSchema>;
export type BrowserClickToolInput = Static<typeof browserClickSchema>;
export type BrowserFillToolInput = Static<typeof browserFillSchema>;
export type BrowserPressToolInput = Static<typeof browserPressSchema>;
export type BrowserScrollToolInput = Static<typeof browserScrollSchema>;
export type BrowserWaitToolInput = Static<typeof browserWaitSchema>;
export type BrowserEvaluateToolInput = Static<typeof browserEvaluateSchema>;

export function createAiraBrowserToolDefinitions(
	toolCtx: AiraBrowserToolContext,
): Record<string, ToolDefinition<any, any, any>> {
	const { runtime } = toolCtx;

	const openTool: ToolDefinition<typeof browserOpenSchema, undefined, undefined> = {
		name: "browser_open",
		label: "browser open",
		description:
			"Open (or reuse) the Aira browser: an ISOLATED Aira-owned Chromium with a disposable profile. It never attaches to your personal browser. Local verification (localhost/loopback) is the default; the browser is headless. Use browser_observe after opening to see the page semantically.",
		promptSnippet: "Open the isolated Aira browser",
		promptGuidelines: [
			"Prefer local/loopback URLs — the isolated profile has no personal cookies or logins.",
			"The browser persists across tool calls within this session; close it with browser_close when done.",
		],
		parameters: browserOpenSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "open", () => runtime.open(paramsToOpenOptions(params)));
		},
		renderCall: (args: Record<string, unknown>, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold(`open ${str(args.url ?? "")}`.trim())), 0, 0),
		renderResult: renderTextResult,
	};

	const statusTool: ToolDefinition<typeof browserStatusSchema, undefined, undefined> = {
		name: "browser_status",
		label: "browser status",
		description:
			"Compact read-only browser status: availability, session state, active tab, console/network counts, verification state. No page interaction happens. Read-only.",
		promptSnippet: "Show browser status",
		parameters: browserStatusSchema,
		executionMode: "sequential",
		async execute() {
			const status = runtime.status();
			return { content: [{ type: "text", text: formatStatus(status) }], details: undefined };
		},
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("browser status")), 0, 0),
		renderResult: renderTextResult,
	};

	const observeTool: ToolDefinition<typeof browserObserveSchema, undefined, undefined> = {
		name: "browser_observe",
		label: "browser observe",
		description:
			"Semantic page observation: title, URL, readyState, a one-line summary, and a bounded accessibility-tree outline with stable element refs ([e1], [e2], ...) for interaction. Structured observation is preferred over screenshots. Pass refs from here to browser_click/browser_fill/browser_press. Re-observe after navigation or major re-renders; a stale ref fails truthfully. Read-only.",
		promptSnippet: "Observe the page semantically (accessibility tree + stable refs)",
		promptGuidelines: [
			"PREFER structured observation over screenshots: this tool gives roles, names, states, and refs.",
			"Pass refs (NOT coordinates) to browser_click / browser_fill — refs survive re-renders.",
			"A 'ref is stale' error means the page changed — re-observe for fresh refs.",
		],
		parameters: browserObserveSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "observe", async () => {
				const options: AiraBrowserObserveOptions = {
					maxNodes: params.maxNodes,
					maxChars: params.maxChars,
					withEvidence: true,
				};
				const result = await runtime.observe(options);
				return {
					ok: true,
					operation: "observe",
					tab: {
						id: "",
						url: result.observation.url,
						title: result.observation.title,
						readyState: result.observation.readyState,
					},
					text: formatObservation(result.observation, result.console, result.network),
				};
			});
		},
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("observe")), 0, 0),
		renderResult: renderTextResult,
	};

	const navigateTool: ToolDefinition<typeof browserNavigateSchema, undefined, undefined> = {
		name: "browser_navigate",
		label: "browser navigate",
		description:
			"Navigate the active tab to a URL and wait for the page to become ready. Returns fresh page state plus console/network evidence counts. Navigation in a disposable isolated profile is safe read-only browsing; use it before browser_observe for a new page.",
		promptSnippet: "Navigate the browser tab",
		parameters: browserNavigateSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "navigate", () => {
				const options: AiraBrowserNavigateOptions = {
					url: params.url,
					waitUntil: params.waitUntil,
					timeoutMs: params.timeout !== undefined ? params.timeout * 1000 : undefined,
				};
				return runtime.navigate(options);
			});
		},
		renderCall: (args: Record<string, unknown>, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold(`navigate ${str(args.url)}`)), 0, 0),
		renderResult: renderTextResult,
	};

	const clickTool: ToolDefinition<typeof browserClickSchema, undefined, undefined> = {
		name: "browser_click",
		label: "browser click",
		description:
			"Click an element. PREFERRED: pass `ref` from browser_observe (e.g. 'e12') — it re-resolves the element's live position at click time. Fallback: x/y viewport coordinates. Appends a compact page-change diff when the click changed the page. The Aira browser is an isolated disposable profile.",
		promptSnippet: "Click an element by ref (preferred) or coordinates",
		promptGuidelines: [
			"PREFER ref from browser_observe — coordinates go stale after re-renders.",
			"A 'ref is stale' error means the page changed; re-observe for fresh refs.",
			"Read the appended page-change diff to confirm the action landed.",
		],
		parameters: browserClickSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "click", () => {
				const options: AiraBrowserClickOptions = {
					ref: params.ref,
					x: params.x,
					y: params.y,
					button: params.button,
					count: params.count as 1 | 2 | 3 | undefined,
				};
				return runtime.click(options);
			});
		},
		renderCall: (args: Record<string, unknown>, theme: Theme) =>
			new Text(
				theme.fg(
					"toolTitle",
					theme.bold(`click ${args.ref ? `[${args.ref}]` : `(${str(args.x)}, ${str(args.y)})`}`),
				),
				0,
				0,
			),
		renderResult: renderTextResult,
	};

	const fillTool: ToolDefinition<typeof browserFillSchema, undefined, undefined> = {
		name: "browser_fill",
		label: "browser fill",
		description:
			"Fill a form field by ref from browser_observe. Handles text inputs, textareas, contenteditable, native selects (value/label/text match), checkboxes, and radios (pass true/false). Uses the native value setter and fires bubbling input/change, so React/Vue controlled inputs keep the value. Appends a compact page-change diff.",
		promptSnippet: "Fill/select/check a form field by ref",
		promptGuidelines: ["PREFER ref from browser_observe.", "For selects pass the option value, label, or text."],
		parameters: browserFillSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "fill", () => runtime.fill(params.ref, params.value));
		},
		renderCall: (args: Record<string, unknown>, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold(`fill [${str(args.ref)}]`)), 0, 0),
		renderResult: renderTextResult,
	};

	const pressTool: ToolDefinition<typeof browserPressSchema, undefined, undefined> = {
		name: "browser_press",
		label: "browser press",
		description:
			"Press a key at the focused element: Enter, Tab, Backspace, Delete, Escape, arrows, Home, End, PageUp, PageDown, or any character. Optional modifier bitfield (1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift). Appends a compact page-change diff.",
		promptSnippet: "Press a key",
		parameters: browserPressSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "press", () => runtime.pressKey(params.key, params.modifiers ?? 0));
		},
		renderCall: (args: Record<string, unknown>, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold(`press ${str(args.key)}`)), 0, 0),
		renderResult: renderTextResult,
	};

	const scrollTool: ToolDefinition<typeof browserScrollSchema, undefined, undefined> = {
		name: "browser_scroll",
		label: "browser scroll",
		description:
			"Scroll the page (or at a ref). deltaY positive scrolls down, negative scrolls up (default 300). Read-only page inspection aid.",
		promptSnippet: "Scroll the page",
		parameters: browserScrollSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "scroll", () =>
				runtime.scroll(params.ref, params.deltaX ?? 0, params.deltaY ?? 300),
			);
		},
		renderCall: (_args: Record<string, unknown>, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold("scroll")), 0, 0),
		renderResult: renderTextResult,
	};

	const waitTool: ToolDefinition<typeof browserWaitSchema, undefined, undefined> = {
		name: "browser_wait",
		label: "browser wait",
		description:
			"Wait for a bounded condition: a CSS selector (kind=selector), visible text (kind=text), URL substring (kind=url), ready state (kind=ready), or a fixed delay (kind=time). Returns fresh page state or a truthful timeout. Read-only.",
		promptSnippet: "Wait for a page condition",
		parameters: browserWaitSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "wait", () => {
				const condition = paramsToWaitCondition(params);
				return runtime.wait(condition, (params.timeout ?? 10) * 1000);
			});
		},
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("wait")), 0, 0),
		renderResult: renderTextResult,
	};

	const evaluateTool: ToolDefinition<typeof browserEvaluateSchema, undefined, undefined> = {
		name: "browser_evaluate",
		label: "browser evaluate",
		description:
			"Run a small expression in the page (main world, returnByValue, promises awaited). The result is summarized; keep expressions read-only and small. Use structured observation first; evaluation is for targeted state reads.",
		promptSnippet: "Evaluate a small expression in the page",
		parameters: browserEvaluateSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "evaluate", () =>
				runtime.evaluate(params.expression, (params.timeout ?? 10) * 1000),
			);
		},
		renderCall: (args: Record<string, unknown>, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold(`evaluate ${str(args.expression)?.slice(0, 60)}`)), 0, 0),
		renderResult: renderTextResult,
	};

	const consoleTool: ToolDefinition<typeof browserConsoleSchema, undefined, undefined> = {
		name: "browser_console",
		label: "browser console",
		description:
			"Bounded console evidence: uncaught exceptions, page errors, console.error/warn, deduplicated with counts. Routine logs appear as counts only. Returns a bounded drain with the top finding. Read-only.",
		promptSnippet: "Inspect console evidence",
		parameters: browserConsoleSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const drain = await runtime.consoleEvidence(params.levels, params.sinceSeq, params.limit);
			return { content: [{ type: "text", text: formatConsoleDrain(drain) }], details: undefined };
		},
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("console")), 0, 0),
		renderResult: renderTextResult,
	};

	const networkTool: ToolDefinition<typeof browserNetworkSchema, undefined, undefined> = {
		name: "browser_network",
		label: "browser network",
		description:
			"Bounded network failure evidence: failed/aborted/blocked requests and relevant 4xx/5xx, deduplicated with counts. Successful traffic is not retained. Read-only.",
		promptSnippet: "Inspect network failure evidence",
		parameters: browserNetworkSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const drain = await runtime.networkEvidence(params.sinceSeq, params.limit);
			return { content: [{ type: "text", text: formatNetworkDrain(drain) }], details: undefined };
		},
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("network")), 0, 0),
		renderResult: renderTextResult,
	};

	const screenshotTool: ToolDefinition<typeof browserScreenshotSchema, undefined, undefined> = {
		name: "browser_screenshot",
		label: "browser screenshot",
		description:
			"Capture one screenshot of the active tab to an Aira-managed path and return the reference (never image bytes in state). Use when appearance/layout matters and structured observation is insufficient — not as a default inspection step.",
		promptSnippet: "Capture a screenshot (appearance matters)",
		parameters: browserScreenshotSchema,
		executionMode: "sequential",
		async execute() {
			const result = await runtime.screenshot();
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `screenshot failed: ${result.reason ?? "unknown"}` }],
					details: undefined,
				};
			}
			return { content: [{ type: "text", text: `screenshot: ${result.path}` }], details: undefined };
		},
		renderCall: (_args, theme: Theme) => new Text(theme.fg("toolTitle", theme.bold("screenshot")), 0, 0),
		renderResult: renderTextResult,
	};

	const verifyTool: ToolDefinition<typeof browserVerifySchema, undefined, undefined> = {
		name: "browser_verify",
		label: "browser verify",
		description:
			"Run ONE bounded verification pass over the local app: open the isolated browser if needed, navigate to the target URL (default: discovered from the running dev process), observe the page, and record console/network evidence as check passed/failed. No retry loops. REVIEW mode emphasizes this flow.",
		promptSnippet: "Run one bounded browser verification pass",
		parameters: browserVerifySchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "verify", () => runtime.verify(params.url));
		},
		renderCall: (args: Record<string, unknown>, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold(`verify ${str(args.url ?? "")}`.trim())), 0, 0),
		renderResult: renderTextResult,
	};

	const closeTool: ToolDefinition<typeof browserCloseSchema, undefined, undefined> = {
		name: "browser_close",
		label: "browser close",
		description:
			"Close the Aira browser session (kills the Aira-owned browser process; the disposable profile is removed) or close a single tab when `tab` is given. Used at the end of browser work.",
		promptSnippet: "Close the Aira browser (or one tab)",
		parameters: browserCloseSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return runBrowserOp(runtime, "close", () => runtime.close(params.tab));
		},
		renderCall: (args: Record<string, unknown>, theme: Theme) =>
			new Text(theme.fg("toolTitle", theme.bold(`close ${str(args.tab ?? "")}`.trim())), 0, 0),
		renderResult: renderTextResult,
	};

	return {
		browser_open: openTool,
		browser_status: statusTool,
		browser_observe: observeTool,
		browser_navigate: navigateTool,
		browser_click: clickTool,
		browser_fill: fillTool,
		browser_press: pressTool,
		browser_scroll: scrollTool,
		browser_wait: waitTool,
		browser_evaluate: evaluateTool,
		browser_console: consoleTool,
		browser_network: networkTool,
		browser_screenshot: screenshotTool,
		browser_verify: verifyTool,
		browser_close: closeTool,
	};
}

// =========================================================================
// Formatting
// =========================================================================

function formatObservation(
	observation: AiraBrowserObservation,
	console: { errors: number; warnings: number; topFinding?: unknown },
	network: { failures: number; topFinding?: unknown },
): string {
	const lines = [
		`${observation.title ? `# ${observation.title}` : "# (untitled)"}`,
		`URL: ${observation.url}`,
		`state: ${observation.readyState} · ${observation.summary} · ${observation.nodeCount} nodes`,
		observation.truncated ? "[tree truncated — re-observe with a larger budget for more]" : "",
		"",
		"```",
		observation.outline,
		"```",
		"",
		evidenceLine(console, network),
	].filter((line) => line !== "");
	return lines.join("\n");
}

function evidenceLine(
	console: { errors: number; warnings: number; topFinding?: unknown },
	network: { failures: number; topFinding?: unknown },
): string {
	const parts: string[] = [];
	if (console.errors + console.warnings > 0) {
		parts.push(`console: ${console.errors}E ${console.warnings}W`);
	}
	if (network.failures > 0) {
		parts.push(`network: ${network.failures} failed`);
	}
	const top = console.topFinding ?? network.topFinding;
	if (top) {
		const finding = top as { message?: string; source?: string; line?: number };
		const location = finding.source
			? ` ${finding.source}${finding.line !== undefined ? `:${finding.line}` : ""}`
			: "";
		parts.push(`top finding: ${finding.message ?? "?"}${location}`);
	}
	return parts.length > 0 ? `evidence: ${parts.join(" · ")}` : "evidence: clean";
}

function formatStatus(status: AiraBrowserStatus): string {
	const tab = status.activeTab;
	const lines = [
		`browser: ${status.status} (${status.provider}, ${status.profileKind} profile)`,
		`availability: ${status.availability}${status.reason ? ` — ${status.reason}` : ""}`,
		`eligible: ${status.eligible}`,
	];
	if (tab) {
		lines.push(
			`active tab: ${tab.id} · ${tab.url || "(blank)"} · ${tab.title}${tab.readyState ? ` (${tab.readyState})` : ""}`,
		);
	}
	lines.push(
		`console: ${status.console.errors}E ${status.console.warnings}W${status.console.topFinding ? ` · ${status.console.topFinding.message}` : ""}`,
		`network: ${status.network.failures} failed`,
		`verification: ${status.verification.status}${status.verification.finding ? ` · ${status.verification.finding.message}` : ""}`,
	);
	if (status.observation.summary) {
		lines.push(`observation: ${status.observation.summary}`);
	}
	return lines.join("\n");
}

function formatConsoleDrain(drain: AiraBrowserEvidenceDrain): string {
	const records = drain.records as AiraBrowserConsoleRecord[];
	const lines: string[] = [];
	if (records.length === 0) {
		return `console evidence: clean (${drain.errors ?? 0} errors, ${drain.warnings ?? 0} warnings total)`;
	}
	lines.push(`console evidence (${drain.total} total, showing ${records.length}):`);
	for (const record of records) {
		const location = record.source ? ` ${record.source}${record.line !== undefined ? `:${record.line}` : ""}` : "";
		const count = record.count > 1 ? ` ×${record.count}` : "";
		lines.push(`  ${record.level}: ${record.text}${location}${count}`);
	}
	if (drain.overflowed) lines.push("[buffer overflowed — older records dropped]");
	return lines.join("\n");
}

function formatNetworkDrain(drain: AiraBrowserEvidenceDrain): string {
	const records = drain.records as AiraBrowserNetworkRecord[];
	const lines: string[] = [];
	if (records.length === 0) {
		return `network evidence: clean (${drain.failures ?? 0} failures total)`;
	}
	lines.push(`network failures (${drain.failures ?? 0} total, showing ${records.length}):`);
	for (const record of records) {
		const status = record.status !== undefined ? ` HTTP ${record.status}` : "";
		const error = record.errorText ? ` — ${record.errorText}` : "";
		const count = record.count > 1 ? ` ×${record.count}` : "";
		lines.push(`  ${record.method} ${record.url}${status}${error}${count}`);
	}
	if (drain.overflowed) lines.push("[buffer overflowed — older records dropped]");
	return lines.join("\n");
}

function formatOperationResult(result: AiraBrowserOperationResult): string {
	const lines = [`${result.ok ? "ok" : "fail"} · ${result.operation}${result.target ? ` ${result.target}` : ""}`];
	if (!result.ok && result.reason) {
		lines.push(`reason: ${result.reason}`);
	}
	if (result.tab) {
		lines.push(
			`page: ${result.tab.url || "(blank)"}${result.tab.title ? ` · ${result.tab.title}` : ""} (${result.tab.readyState})`,
		);
	}
	if (result.console) {
		const counts = `${result.console.errors}E ${result.console.warnings}W`;
		const top = result.console.topFinding ? ` · ${result.console.topFinding.message}` : "";
		lines.push(`console: ${counts}${top}`);
	}
	if (result.network) {
		const top = result.network.topFinding ? ` · ${result.network.topFinding.message}` : "";
		lines.push(`network: ${result.network.failures} failed${top}`);
	}
	if (result.changes && result.changes.length > 0) {
		lines.push("", "Page changes:");
		for (const change of result.changes.slice(0, 12)) {
			lines.push(`  ${changeLabel(change)}`);
		}
		if (result.changes.length > 12)
			lines.push(`  …and ${result.changes.length - 12} more (browser_observe for full state)`);
	}
	if (result.summary !== undefined) {
		lines.push(`value: ${result.summary}`);
	}
	return lines.join("\n");
}

function changeLabel(change: AiraBrowserChange): string {
	const glyph = change.kind === "new" ? "*" : change.kind === "removed" ? "-" : "~";
	const name = change.name ? ` "${change.name.slice(0, 60)}"` : "";
	return `${glyph} ${change.kind} [${change.ref}] ${change.role}${name}`;
}

async function runBrowserOp(
	_runtime: AiraBrowserHandle,
	operation: string,
	fn: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	try {
		const result = await fn();
		if (isOperationResult(result)) {
			// A formatted observation result carries its own text.
			if ("text" in result && typeof (result as { text?: unknown }).text === "string") {
				return { content: [{ type: "text", text: (result as { text: string }).text }], details: undefined };
			}
			return { content: [{ type: "text", text: formatOperationResult(result) }], details: undefined };
		}
		const text =
			(result as { content?: Array<{ type: string; text?: string }> }).content
				?.map((b) => b.text ?? "")
				.join("\n") ?? "";
		return { content: [{ type: "text", text }], details: undefined };
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text:
						err instanceof AiraBrowserNotOpenError
							? err.message
							: `${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
			details: undefined,
		};
	}
}

function isOperationResult(value: unknown): value is AiraBrowserOperationResult {
	return typeof value === "object" && value !== null && "operation" in value && "ok" in value;
}

function paramsToOpenOptions(params: BrowserOpenToolInput): AiraBrowserManagerOpenOptions {
	return {
		url: params.url,
		timeoutMs: params.timeout !== undefined ? params.timeout * 1000 : undefined,
	};
}

function paramsToWaitCondition(params: BrowserWaitToolInput): AiraBrowserWaitCondition {
	switch (params.kind ?? "selector") {
		case "time":
			return { kind: "time", ms: params.ms ?? 1000 };
		case "text":
			return { kind: "text", text: params.text ?? "" };
		case "url":
			return { kind: "url", substring: params.substring ?? "" };
		case "ready":
			return { kind: "ready", readyState: params.readyState ?? "interactive" };
		default:
			return { kind: "selector", selector: params.selector ?? "" };
	}
}

function renderTextResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Theme,
	context: { lastComponent?: unknown },
): Text {
	const text = (context.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
	const output = getTextOutput(result as never, false).trim();
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 24;
	const display = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let rendered = `\n${display.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		rendered += `\n${theme.fg("muted", `... (${remaining} more lines to expand)`)}`;
	}
	text.setText(rendered);
	return text;
}
