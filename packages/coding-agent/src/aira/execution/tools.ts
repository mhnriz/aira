/**
 * Aira execution — model-facing process tools.
 *
 * Four restrained native tools expose the execution runtime to the model:
 *
 * - process_start   launch a managed process (foreground / background / auto)
 * - process_status  inspect managed processes (read-only)
 * - process_logs    read bounded managed-process logs (read-only)
 * - process_stop    terminate a managed process (graceful → forced)
 *
 * Capability semantics (ADR-022): process_start/process_stop classify as
 * `process` (PLAN-blocked by the existing semantic gate); process_status/
 * process_logs classify as `diagnostic` (safe in read-only contexts) and are
 * part of the PLAN read-only availability set.
 *
 * These tools complement — they do not replace — the bash tool: bash remains
 * the quick command surface; process tools exist for managed execution where
 * Aira owns the lifecycle (dev servers, long tests, builds, reuse).
 */

import { isAbsolute, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { buildCompactRow, type CompactStatus, formatCompactDuration } from "../../core/tools/compact.ts";
import { getTextOutput, str } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { AiraSessionState } from "../state.ts";
import type {
	AiraExecutionResult,
	AiraInteractiveAuthStatus,
	AiraProcessRecord,
	AiraProcessRequest,
	AiraStartOptions,
} from "./types.ts";
import { displayCommand } from "./types.ts";

/** The slice of the execution manager the tools need (host handle satisfies it). */
export interface AiraProcessToolRuntime {
	sessionCwd: string;
	start(request: AiraProcessRequest, options?: AiraStartOptions): Promise<AiraExecutionResult>;
	get(id: string): AiraProcessRecord | undefined;
	list(): readonly AiraProcessRecord[];
	logs(
		id: string,
		tailChars?: number,
	): { stdout: { text: string; truncated: boolean }; stderr: { text: string; truncated: boolean } } | undefined;
	terminate(
		id: string,
		reason?: "user" | "timeout" | "cancelled" | "restart" | "session-end",
	): Promise<AiraProcessRecord | undefined>;
}

export const AIRA_PROCESS_PURPOSES = ["run", "test", "build", "check", "dev", "other"] as const;

const processStartSchema = Type.Object({
	command: Type.Optional(
		Type.String({ description: "Shell command to execute (bash -c form). Mutually exclusive with exe." }),
	),
	exe: Type.Optional(Type.String({ description: "Executable to spawn directly (no shell). Use with args." })),
	args: Type.Optional(Type.Array(Type.String(), { description: "Arguments for exe (ignored with command)." })),
	cwd: Type.Optional(Type.String({ description: "Working directory (absolute, or relative to the session root)." })),
	purpose: Type.Optional(
		Type.Union(
			AIRA_PROCESS_PURPOSES.map((p) => Type.Literal(p)),
			{ description: "Why the process is launched (dev servers must be dev for reuse)." },
		),
	),
	background: Type.Optional(
		Type.Union([Type.Boolean(), Type.Literal("auto")], {
			description:
				'false = foreground (default, waits for completion). true = background (managed). "auto" = foreground until it outlives the auto-background threshold (~20s), then becomes managed background.',
		}),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (foreground; also bounds background runs)." }),
	),
	reuse: Type.Optional(
		Type.Union([Type.Literal("new"), Type.Literal("reuse"), Type.Literal("restart")], {
			description:
				"new = always launch (default). reuse = return the still-running managed dev process with the same command+cwd if one exists. restart = terminate a matching one first, then launch.",
		}),
	),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Run through a local PTY and allow the attached local UI to answer password-like prompts; unavailable in headless mode.",
		}),
	),
});

const processStatusSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Process id (omitted to list all managed processes)." })),
});

const processLogsSchema = Type.Object({
	id: Type.String({ description: "Process id." }),
	stream: Type.Optional(
		Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("all")], {
			description: "Which stream to read (default: all).",
		}),
	),
	tail: Type.Optional(Type.Number({ description: "Tail characters per stream (default 4000, max 20000)." })),
});

const processStopSchema = Type.Object({
	id: Type.String({ description: "Process id." }),
});

export type ProcessStartToolInput = Static<typeof processStartSchema>;

const MAX_TIMEOUT_MS = 2_147_483_647;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error("Invalid timeout: too large");
	}
	return timeoutMs;
}

function resolveToolCwd(cwd: string | undefined, sessionRoot: string): string {
	if (!cwd) {
		return sessionRoot;
	}
	return isAbsolute(cwd) ? cwd : resolve(sessionRoot, cwd);
}

// =========================================================================
// Output formatting (shared by tool content text and TUI rendering)
// =========================================================================

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function formatProcessLine(record: {
	id: string;
	status: string;
	command: string;
	startedAt: number;
	exitedAt?: number;
	exitCode?: number | null;
	pid?: number;
	interactive?: boolean;
	interactiveInputPending?: boolean;
	interactiveAuth?: AiraInteractiveAuthStatus;
}): string {
	const age =
		record.exitedAt !== undefined
			? formatDuration(record.exitedAt - record.startedAt)
			: formatDuration(Date.now() - record.startedAt);
	const code = record.exitCode !== undefined && record.exitCode !== null ? ` code ${record.exitCode}` : "";
	const input = record.interactive
		? `  interactive${record.interactiveInputPending ? " · awaiting local input" : record.interactiveAuth ? ` · auth ${record.interactiveAuth}` : ""}`
		: "";
	return `${record.id}  ${record.status.padEnd(9)}  ${record.command}  ${age}${code}${input}`;
}

function processLineOf(record: AiraProcessRecord): {
	id: string;
	status: string;
	command: string;
	startedAt: number;
	exitedAt?: number;
	exitCode?: number | null;
	pid?: number;
	interactive?: boolean;
	interactiveInputPending?: boolean;
	interactiveAuth?: AiraInteractiveAuthStatus;
} {
	return {
		id: record.id,
		status: record.status,
		command: displayCommand(record.request),
		startedAt: record.startedAt,
		exitedAt: record.exitedAt,
		exitCode: record.exitCode,
		pid: record.pid,
		interactive: record.interactive,
		interactiveInputPending: record.interactiveInputPending,
		interactiveAuth: record.interactiveAuth,
	};
}

export function formatStartResult(result: AiraExecutionResult): string {
	const lines: string[] = [];
	const duration = formatDuration(result.durationMs);
	if (result.status === "backgrounded") {
		const reused = result.reused ? "Reused running managed process" : "Started managed process";
		lines.push(`${reused} ${result.processId ?? "?"} (${result.command})`);
		lines.push(`It keeps running${result.reused ? "" : "; logs are captured"}.`);
		if (!result.reused) {
			lines.push(
				`Inspect: process_status id=${result.processId} · Logs: process_logs id=${result.processId} · Stop: process_stop id=${result.processId}`,
			);
		}
		return lines.join("\n");
	}
	if (result.status === "spawn-failed") {
		return `Failed to launch: ${result.reason ?? "spawn error"}`;
	}
	if (result.status === "unavailable") {
		return `Cannot run: ${result.reason ?? "unavailable"}`;
	}
	if (result.status === "timed-out") {
		lines.push(`Timed out after ${duration}${result.reason ? ` (${result.reason})` : ""}`);
	} else if (result.status === "cancelled") {
		lines.push("Cancelled");
	} else if (result.status === "terminated") {
		lines.push(`Terminated after ${duration}${result.reason ? ` (${result.reason})` : ""}`);
	} else if (result.exitCode === 0) {
		lines.push(`exit code 0 · ${duration}`);
	} else {
		lines.push(`Command failed: exit code ${result.exitCode ?? "?"} · ${duration}`);
	}
	if (result.interactiveAuth) {
		lines.push(`local authentication: ${result.interactiveAuth}`);
	}
	const stdout = result.stdout.text.trim();
	const stderr = result.stderr.text.trim();
	if (stdout) {
		lines.push(stdout);
		if (result.stdout.truncated) {
			lines.push(`[stdout truncated: tail only]`);
		}
	}
	if (stderr) {
		lines.push(stderr);
		if (result.stderr.truncated) {
			lines.push(`[stderr truncated: tail only]`);
		}
	}
	return lines.join("\n");
}

function formatStatusOutput(manager: AiraProcessToolRuntime, id: string | undefined): string {
	if (id === undefined) {
		const records = manager.list();
		if (records.length === 0) {
			return "(no managed processes)";
		}
		return ["managed processes:", ...records.map((r) => formatProcessLine(processLineOf(r)))].join("\n");
	}
	const record = manager.get(id);
	if (!record) {
		return `no managed process ${id}`;
	}
	const lines = [formatProcessLine(processLineOf(record))];
	if (record.exitReason) {
		lines.push(`exit reason: ${record.exitReason}`);
	}
	if (record.pid !== undefined) {
		lines.push(`pid: ${record.pid}`);
	}
	return lines.join("\n");
}

function formatLogsOutput(
	manager: AiraProcessToolRuntime,
	id: string,
	stream: "stdout" | "stderr" | "all" | undefined,
	tail: number,
): string {
	const logs = manager.logs(id, tail);
	if (!logs) {
		return `no managed process ${id}`;
	}
	const lines: string[] = [];
	const pushStream = (label: string, log: { text: string; truncated: boolean }) => {
		const text = log.text.trim();
		if (stream !== "all" && stream !== undefined) {
			lines.push(`process ${id} ${label} (tail ${tail} chars):`);
		}
		if (text) {
			lines.push(text);
		} else {
			lines.push(`(no ${label} output)`);
		}
		if (log.truncated) {
			lines.push(`[${label} truncated: tail only]`);
		}
	};
	const showStdout = stream === "stdout" || stream === "all" || stream === undefined;
	const showStderr = stream === "stderr" || stream === "all" || stream === undefined;
	if (!showStdout) {
		pushStream("stderr", logs.stderr);
		return lines.join("\n");
	}
	if (!showStderr) {
		pushStream("stdout", logs.stdout);
		return lines.join("\n");
	}
	pushStream("stdout", logs.stdout);
	pushStream("stderr", logs.stderr);
	return lines.join("\n");
}

/** Display target of a process_start call (command or exe + args). */
function processStartTarget(args: { command?: string; exe?: string; args?: readonly string[] } | undefined): string {
	const command = str(args?.command);
	if (command) return command;
	const exe = str(args?.exe);
	if (!exe) return "…";
	const rest = (args?.args ?? []).join(" ");
	return rest ? `${exe} ${rest}` : exe;
}

function formatStopOutput(record: AiraProcessRecord): string {
	const age = formatDuration((record.exitedAt ?? Date.now()) - record.startedAt);
	if (record.status === "terminated") {
		if (record.exitReason === "restart") {
			return `process ${record.id} stopped for restart (was running ${age})`;
		}
		return `process ${record.id} terminated after ${age}`;
	}
	if (record.status === "exited") {
		return `process ${record.id} already exited (code ${record.exitCode ?? "?"})`;
	}
	if (record.status === "spawn-failed") {
		return `process ${record.id} never started (${record.spawnError ?? "spawn failure"})`;
	}
	return `process ${record.id} ${record.status}`;
}

// =========================================================================
// Compact (collapsed/summary) process rows
// =========================================================================

const COMPACT_TAIL_LINES = 6;
const COMPACT_EXCERPT_LINES = 4;

/** Render state for live process duration polling (backgrounded starts). */
type ProcessRenderState = {
	interval: ReturnType<typeof setInterval> | undefined;
};

/** Bounded error/failure tail of a process output. */
function compactErrorTail(stderrText: string, stdoutText: string): string[] {
	const text = stderrText.trim() || stdoutText.trim();
	const lines = text.split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.slice(-COMPACT_TAIL_LINES);
}

/** Compact row for a settled (non-backgrounded) process execution result. */
function compactSettledProcessRow(
	result: AiraExecutionResult,
	theme: Theme,
): { row: string; tail: string[]; status: CompactStatus } {
	const excerpt: string[] = [];
	const duration = theme.fg("muted", formatCompactDuration(result.durationMs));
	let status: CompactStatus = "success";
	if (result.status === "exited" && result.ok) {
		excerpt.push(duration);
	} else if (result.status === "exited") {
		status = "error";
		excerpt.push(theme.fg("error", `exit ${result.exitCode ?? "?"}`), duration);
	} else if (result.status === "timed-out") {
		status = "error";
		excerpt.push(theme.fg("error", "timed out"), duration);
	} else if (result.status === "terminated") {
		status = "warning";
		excerpt.push(theme.fg("warning", "terminated"), duration);
	} else if (result.status === "cancelled") {
		status = "warning";
		excerpt.push(theme.fg("warning", "cancelled"), duration);
	} else {
		status = "error";
		excerpt.push(theme.fg("error", result.reason ?? "failed"));
	}
	return {
		row: buildCompactRow(theme, {
			status,
			label: "process",
			targetText: result.command,
			excerpt,
		}),
		tail: status === "error" ? compactErrorTail(result.stderr.text, result.stdout.text) : [],
		status,
	};
}

/** Managed-process row for a backgrounded start, with live status polling. */
function compactBackgroundedProcessRow(
	processId: string | undefined,
	result: AiraExecutionResult,
	theme: Theme,
	manager: AiraProcessToolRuntime,
	state: ProcessRenderState,
	invalidate: () => void,
): { row: string; tail: string[]; status: CompactStatus } {
	const record = processId !== undefined ? manager.get(processId) : undefined;
	const excerpt: string[] = [];
	let status: CompactStatus = "running";
	if (record?.status === "running") {
		if (!state.interval) {
			state.interval = setInterval(() => invalidate(), 1000);
		}
		excerpt.push(
			theme.fg("muted", "running"),
			theme.fg("muted", formatCompactDuration(Date.now() - (record.startedAt ?? result.startedAt))),
		);
		if (record.pid !== undefined) {
			excerpt.unshift(theme.fg("muted", `pid ${record.pid}`));
		}
	} else {
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
		const age = record && record.exitedAt !== undefined ? record.exitedAt - record.startedAt : result.durationMs;
		const duration = theme.fg("muted", formatCompactDuration(age));
		if (record?.exitCode === 0) {
			status = "success";
			excerpt.push(duration);
		} else if (record) {
			status = record.exitCode !== undefined ? "error" : "warning";
			excerpt.push(
				theme.fg(
					status === "error" ? "error" : "warning",
					record.exitCode !== undefined ? `exit ${record.exitCode}` : record.status,
				),
				duration,
			);
		} else {
			// Record already reaped: fall back to the snapshot at backgrounding time.
			excerpt.push(theme.fg("muted", "backgrounded"), duration);
			status = "success";
		}
	}
	return {
		row: buildCompactRow(theme, { status, label: "process", targetText: result.command, excerpt }),
		tail:
			status === "error"
				? compactErrorTail(
						record ? record.stderr.text() : result.stderr.text,
						record ? record.stdout.text() : result.stdout.text,
					)
				: [],
		status,
	};
}

// =========================================================================
// Tool definitions
// =========================================================================

export interface AiraProcessToolContext {
	manager: AiraProcessToolRuntime;
	state: AiraSessionState;
}

export function createAiraProcessToolDefinitions(
	toolCtx: AiraProcessToolContext,
): Record<string, ToolDefinition<any, any, any>> {
	const { manager, state } = toolCtx;
	const sessionCwd = state.project?.root ?? manager.sessionCwd;

	const startTool: ToolDefinition<
		typeof processStartSchema,
		{ processId?: string; result?: AiraExecutionResult },
		ProcessRenderState
	> = {
		name: "process_start",
		label: "process start",
		description:
			"Launch a managed process in the session working directory. Use for long-running or owned commands: dev servers (background, purpose dev, reuse reuse), tests, builds, and type checks. For quick one-off commands prefer bash. Foreground runs wait and return the exit code with bounded output tails; background runs return immediately with a process id that process_status/process_logs/process_stop manage. Background processes keep running after this tool returns and are cleaned up when the session ends. Output in results is a bounded tail (full logs stay accessible via process_logs).",
		promptSnippet: "Launch managed processes (dev servers, tests, builds)",
		promptGuidelines: [
			"Use background + purpose dev for development servers; reuse with reuse=reuse so a compatible running server is reused instead of spawned again.",
			"Prefer foreground for short verification (tests, builds, checks); set timeout only when a bound is needed.",
			"Use background=auto when a command may be either quick or long-running: it stays foreground if it finishes quickly and becomes a managed background process if it outlives ~20s.",
			"Use interactive=true only when the command requires a local terminal; secrets are collected by the local UI and never returned to the model.",
			"process_start never times out by itself: it runs until the process exits (or timeout is given).",
		],
		parameters: processStartSchema,
		async execute(_toolCallId, params, signal) {
			const hasCommand = params.command !== undefined;
			const hasExe = params.exe !== undefined;
			if (hasCommand === hasExe) {
				throw new Error("process_start requires exactly one of command or exe");
			}
			const cwd = resolveToolCwd(params.cwd, sessionCwd);
			const request: AiraProcessRequest = hasCommand
				? { command: params.command, cwd }
				: { exe: params.exe, args: params.args ?? [], cwd };
			const startOptions: AiraStartOptions = {
				purpose: params.purpose ?? undefined,
				mode: params.background === true ? "background" : params.background === "auto" ? "auto" : "foreground",
				reuse: params.reuse ?? "new",
				interactive: params.interactive === true,
				timeoutMs: resolveTimeoutMs(params.timeout),
				signal,
			};
			const result = await manager.start(request, startOptions);
			return {
				content: [{ type: "text", text: formatStartResult(result) }],
				details: { processId: result.processId, result },
			};
		},
		renderCall(args, theme: Theme, context) {
			const command = processStartTarget(args);
			if (!context.expanded) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				if (context.hasResult) {
					// Compact: the result renderer owns the row once a result exists.
					text.setText("");
					return text;
				}
				text.setText(
					buildCompactRow(theme, {
						status: context.isError ? "error" : context.isPartial ? "running" : "success",
						label: "process",
						targetText: command,
					}),
				);
				return text;
			}
			return new Text(theme.fg("toolTitle", theme.bold(`start ${command}`)), 0, 0);
		},
		renderResult(result, options, theme: Theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (!context.expanded) {
				const details = (result as { details?: { processId?: string; result?: AiraExecutionResult } }).details;
				const execResult = details?.result;
				const command = execResult?.command ?? processStartTarget(context.args);
				const lines: string[] = [];
				let tail: string[] = [];
				if (context.isError || !execResult) {
					const status: CompactStatus = context.isError ? "error" : options.isPartial ? "running" : "success";
					lines.push(buildCompactRow(theme, { status, label: "process", targetText: command }));
					if (context.isError) {
						tail = getTextOutput(result as any, context.showImages)
							.trim()
							.split("\n")
							.slice(-COMPACT_TAIL_LINES);
					}
				} else if (execResult.status === "backgrounded") {
					const row = compactBackgroundedProcessRow(
						details.processId,
						execResult,
						theme,
						manager,
						context.state,
						context.invalidate,
					);
					lines.push(row.row);
					tail = row.tail;
				} else {
					const row = compactSettledProcessRow(execResult, theme);
					lines.push(row.row);
					tail = row.tail;
				}
				for (const line of tail) {
					if (line.trim()) lines.push(theme.fg("error", line));
				}
				text.setText(lines.join("\n"));
				return text;
			}
			const output = getTextOutput(result as any, context.showImages).trim();
			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 20;
			const display = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			let rendered = `\n${display.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (remaining > 0) {
				rendered += `\n${theme.fg("muted", `... (${remaining} more lines to expand)`)}`;
			}
			text.setText(rendered);
			return text;
		},
	};

	const statusTool: ToolDefinition<typeof processStatusSchema, undefined, undefined> = {
		name: "process_status",
		label: "process status",
		description:
			"Inspect managed processes started by process_start. Without id: list all managed processes with id, status, command, age, and exit code. With id: detail for one process (status, exit reason, pid). Read-only.",
		promptSnippet: "Inspect managed processes",
		parameters: processStatusSchema,
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: formatStatusOutput(manager, params.id) }], details: undefined };
		},
		renderCall(args, theme: Theme, context) {
			if (!context.expanded) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				if (context.hasResult) {
					text.setText("");
					return text;
				}
				text.setText(
					buildCompactRow(theme, {
						status: context.isError ? "error" : context.isPartial ? "running" : "success",
						label: "process status",
						targetText: args.id ?? "all",
					}),
				);
				return text;
			}
			return new Text(theme.fg("toolTitle", theme.bold(`status ${args.id ?? ""}`.trim())), 0, 0);
		},
		renderResult(result, options, theme: Theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (!context.expanded) {
				const output = getTextOutput(result as any, context.showImages).trim();
				const lines = output.split("\n").map((line) => line.trimEnd());
				while (lines.length > 0 && lines[lines.length - 1] === "") {
					lines.pop();
				}
				const target = (context.args as { id?: string } | undefined)?.id ?? "all";
				const status: CompactStatus = context.isError ? "error" : options.isPartial ? "running" : "success";
				const excerpt: string[] = [];
				// First data line: "id  status  command  age".
				const dataLine = lines.find((line) => /^\S+\s{2,}\S+/.test(line));
				if (dataLine) {
					const parts = dataLine.trim().split(/\s{2,}/);
					if (parts.length >= 3 && parts[2]) {
						excerpt.push(theme.fg("muted", parts[1]), theme.fg("muted", parts[parts.length - 1]));
					}
				} else if (lines.length === 0 || lines[0] === "(no managed processes)") {
					excerpt.push(theme.fg("muted", "none"));
				}
				text.setText(buildCompactRow(theme, { status, label: "process status", targetText: target, excerpt }));
				return text;
			}
			text.setText(
				`\n${getTextOutput(result as any, context.showImages)
					.trim()
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n")}`,
			);
			return text;
		},
	};

	const logsTool: ToolDefinition<typeof processLogsSchema, undefined, undefined> = {
		name: "process_logs",
		label: "process logs",
		description:
			"Read the captured logs of a managed process (bounded tail; older output is dropped once the per-stream cap is exceeded, with an explicit truncation marker). Read-only.",
		promptSnippet: "Read managed process logs",
		parameters: processLogsSchema,
		async execute(_toolCallId, params) {
			const tail = Math.min(Math.max(params.tail ?? 4000, 100), 20000);
			return {
				content: [{ type: "text", text: formatLogsOutput(manager, params.id, params.stream, tail) }],
				details: undefined,
			};
		},
		renderCall(args, theme: Theme, context) {
			if (!context.expanded) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				if (context.hasResult) {
					text.setText("");
					return text;
				}
				text.setText(
					buildCompactRow(theme, {
						status: context.isError ? "error" : context.isPartial ? "running" : "success",
						label: "process logs",
						targetText: args.id,
					}),
				);
				return text;
			}
			return new Text(theme.fg("toolTitle", theme.bold(`logs ${args.id}`)), 0, 0);
		},
		renderResult(result, options, theme: Theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (!context.expanded) {
				const output = getTextOutput(result as any, context.showImages).trim();
				const lines: string[] = [];
				const status: CompactStatus = context.isError ? "error" : options.isPartial ? "running" : "success";
				lines.push(
					buildCompactRow(theme, {
						status,
						label: "process logs",
						targetText: (context.args as { id?: string } | undefined)?.id ?? "?",
					}),
				);
				if (context.isError) {
					for (const line of output.split("\n").slice(-COMPACT_TAIL_LINES)) {
						if (line.trim()) lines.push(theme.fg("error", line));
					}
				} else if (!options.isPartial) {
					// Bounded newest log excerpt; full logs stay one expand away.
					const allLines = output.split("\n").map((line) => line.trimEnd());
					while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
						allLines.pop();
					}
					const excerptLines = allLines.slice(-COMPACT_EXCERPT_LINES);
					const skipped = allLines.length - excerptLines.length;
					if (skipped > 0) {
						lines.push(theme.fg("muted", `... (${skipped} earlier lines)`));
					}
					for (const line of excerptLines) {
						lines.push(theme.fg("toolOutput", line));
					}
				}
				text.setText(lines.join("\n"));
				return text;
			}
			text.setText(
				`\n${getTextOutput(result as any, context.showImages)
					.trim()
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n")}`,
			);
			return text;
		},
	};

	const stopTool: ToolDefinition<typeof processStopSchema, { processId?: string } | undefined, undefined> = {
		name: "process_stop",
		label: "process stop",
		description:
			"Terminate a managed process: graceful signal first (SIGTERM / taskkill without force), forced kill of the whole process tree if it does not exit within the grace period. Reports the final state truthfully.",
		promptSnippet: "Stop a managed process",
		parameters: processStopSchema,
		async execute(_toolCallId, params) {
			const record = await manager.terminate(params.id, "user");
			if (!record) {
				return { content: [{ type: "text", text: `no managed process ${params.id}` }], details: undefined };
			}
			return { content: [{ type: "text", text: formatStopOutput(record) }], details: { processId: record.id } };
		},
		renderCall(args, theme: Theme, context) {
			if (!context.expanded) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				if (context.hasResult) {
					text.setText("");
					return text;
				}
				text.setText(
					buildCompactRow(theme, {
						status: context.isError ? "error" : context.isPartial ? "running" : "success",
						label: "process stop",
						targetText: args.id,
					}),
				);
				return text;
			}
			return new Text(theme.fg("toolTitle", theme.bold(`stop ${args.id}`)), 0, 0);
		},
		renderResult(result, options, theme: Theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (!context.expanded) {
				const output = getTextOutput(result as any, context.showImages).trim();
				const firstLine = output.split("\n")[0] ?? "";
				const status: CompactStatus = context.isError
					? "error"
					: options.isPartial
						? "running"
						: /never started|no managed process/.test(firstLine)
							? "error"
							: "success";
				const excerpt: string[] = [];
				const terminatedMatch = firstLine.match(/terminated after (.+)/);
				if (terminatedMatch) {
					excerpt.push(theme.fg("muted", "terminated"), theme.fg("muted", terminatedMatch[1]));
				} else {
					const exitedMatch = firstLine.match(/already exited \(code (.+)\)/);
					if (exitedMatch) {
						excerpt.push(theme.fg("muted", "exited"), theme.fg("muted", `code ${exitedMatch[1]}`));
					} else if (status === "error") {
						excerpt.push(theme.fg("error", "not found"));
					}
				}
				const lines = [
					buildCompactRow(theme, {
						status,
						label: "process stop",
						targetText: (context.args as { id?: string } | undefined)?.id ?? "?",
						excerpt,
					}),
				];
				if (context.isError) {
					for (const line of output.split("\n").slice(-COMPACT_TAIL_LINES)) {
						if (line.trim()) lines.push(theme.fg("error", line));
					}
				}
				text.setText(lines.join("\n"));
				return text;
			}
			text.setText(
				`\n${getTextOutput(result as any, context.showImages)
					.trim()
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n")}`,
			);
			return text;
		},
	};

	return {
		process_start: startTool,
		process_status: statusTool,
		process_logs: logsTool,
		process_stop: stopTool,
	};
}
