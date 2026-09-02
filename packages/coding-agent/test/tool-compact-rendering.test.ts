import { Container, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { BoundedOutputBuffer } from "../src/aira/execution/buffer.ts";
import { type AiraProcessToolRuntime, createAiraProcessToolDefinitions } from "../src/aira/execution/tools.ts";
import type { AiraExecutionResult, AiraProcessRecord, AiraProcessRequest } from "../src/aira/execution/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	dissolveGroupFrom,
	regroupToolComponent,
	ToolExecutionGroup,
	tryGroupToolComponent,
} from "../src/modes/interactive/components/tool-execution-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function render(component: ToolExecutionComponent, width = 120): string {
	return stripAnsi(component.render(width).join("\n"));
}

function bashResult(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text", text }], details, isError };
}

describe("Aira compact tool rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("successful read renders one compact row and hides file content", () => {
		const component = new ToolExecutionComponent(
			"read",
			"t-read-1",
			{ path: "src/foo.ts" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "line1\nline2\nline3" }], details: undefined, isError: false },
			false,
		);

		const rendered = render(component);
		expect(rendered).toContain("✓");
		expect(rendered).toContain("read");
		expect(rendered).toContain("src/foo.ts");
		expect(rendered).not.toContain("line1");
		expect(rendered.split("\n").length).toBe(1);
	});

	test("successful edit renders a compact row with a +/- delta", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"t-edit-1",
			{ path: "src/foo.ts", edits: [{ oldText: "a", newText: "b" }] },
			{},
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const diff = [
			"--- a/src/foo.ts",
			"+++ b/src/foo.ts",
			"@@ -1,3 +1,5 @@",
			"-old",
			"-older",
			"+new",
			"+newer",
			"+newest",
		];
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/foo.ts." }],
				details: { diff: diff.join("\n") },
				isError: false,
			},
			false,
		);

		const rendered = render(component);
		expect(rendered).toContain("✓");
		expect(rendered).toContain("edit");
		expect(rendered).toContain("src/foo.ts");
		expect(rendered).toContain("+3");
		expect(rendered).toContain("-2");
		expect(rendered).not.toContain("old");
		expect(rendered.split("\n").length).toBe(1);
	});

	test("successful write renders a compact row with byte count", () => {
		const component = new ToolExecutionComponent(
			"write",
			"t-write-1",
			{ path: "src/new.ts", content: "x" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully wrote 2048 bytes to src/new.ts" }],
				details: undefined,
				isError: false,
			},
			false,
		);

		const rendered = render(component);
		expect(rendered).toContain("write");
		expect(rendered).toContain("src/new.ts");
		expect(rendered).toContain("2.0KB");
	});

	test("successful bash does not dump stdout, shows duration", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const component = new ToolExecutionComponent(
			"bash",
			"t-bash-1",
			{ command: "npm run check" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		vi.setSystemTime(new Date("2026-01-01T00:00:25.000Z"));
		const output = Array.from({ length: 300 }, (_, i) => `log line ${i + 1}`).join("\n");
		component.updateResult(bashResult(output, undefined, false), false);

		const rendered = render(component);
		expect(rendered).toContain("✓");
		expect(rendered).toContain("check");
		expect(rendered).toContain("npm run check");
		expect(rendered).toContain("25.0s");
		expect(rendered).not.toContain("log line 1");
		expect(rendered.split("\n").length).toBe(1);
	});

	test("failed bash renders a headline plus a bounded error tail", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const component = new ToolExecutionComponent(
			"bash",
			"t-bash-2",
			{ command: "npm run check" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		vi.setSystemTime(new Date("2026-01-01T00:00:04.500Z"));
		const output = Array.from({ length: 500 }, (_, i) => `noise ${i + 1}`)
			.concat(["src/foo.ts:12: error TS2322: Type mismatch", "npm error", "Command exited with code 2"])
			.join("\n");
		component.updateResult(bashResult(output, undefined, true), false);

		const rendered = render(component);
		expect(rendered).toContain("✕");
		expect(rendered).toContain("exit 2");
		expect(rendered).toContain("Type mismatch");
		expect(rendered).not.toContain("noise 1");
		expect(rendered).toContain("earlier lines");
		// Bounded: headline + skipped hint + exactly 6 tail lines.
		const lines = rendered.split("\n");
		expect(lines.length).toBe(2 + 6);
	});

	test("test-runner output yields pass/fail counts in the row", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"t-bash-3",
			{ command: "npm test -- tui-multipane.test.ts" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			bashResult(
				"stdout | ✓ tui-multipane.test.ts (41 tests)\n\nTest Files  1 passed\nTests  41 passed (4.5s)",
				undefined,
				false,
			),
			false,
		);

		const rendered = render(component);
		expect(rendered).toContain("✓");
		expect(rendered).toContain("test");
		expect(rendered).toContain("tui-multipane.test.ts");
		expect(rendered).toContain("41 passed");
		expect(rendered).not.toContain("(4.5s)");
	});

	test("failed test-runner output shows the failed count", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"t-bash-4",
			{ command: "npm test -- agent-session-retry.test.ts" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			bashResult(
				"FAIL agent-session-retry.test.ts > retries\nTests  4 failed | 37 passed\nCommand exited with code 1",
				undefined,
				true,
			),
			false,
		);

		const rendered = render(component);
		expect(rendered).toContain("✕");
		expect(rendered).toContain("4 failed");
		expect(rendered).toContain("37 passed");
	});

	test("long successful bash output stays bounded with a truncation warning", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute("t-bash-5", { command: "generate output" }, undefined, undefined, {} as never);

		const component = new ToolExecutionComponent(
			"bash",
			"t-bash-5",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = render(component);
		expect(rendered).toContain("✓");
		expect(rendered).toContain("[truncated:");
		expect(rendered).not.toContain("line-0001");
		expect(rendered).not.toContain("line-4000");
	});

	test("expanded output renders the full result; collapse returns to compact", () => {
		const component = new ToolExecutionComponent(
			"read",
			"t-read-2",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\nthree" }], details: undefined, isError: false },
			false,
		);

		expect(render(component).split("\n").length).toBe(1);

		component.setExpanded(true);
		const expanded = render(component);
		expect(expanded).toContain("one");
		expect(expanded).toContain("three");

		component.setExpanded(false);
		const collapsed = render(component);
		expect(collapsed.split("\n").length).toBe(1);
		expect(collapsed).not.toContain("one");
	});

	test("ANSI and multiline bash output never leaks into the compact row", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"t-bash-6",
			{ command: "echo hi" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			bashResult("plain\n\x1b[31mred text\x1b[0m\n\x1b[1mbold\x1b[22m", undefined, false),
			false,
		);

		const rendered = render(component);
		expect(rendered).not.toContain("\x1b[");
		expect(rendered).not.toContain("red text");
		expect(rendered.split("\n").length).toBe(1);
	});

	test("streaming bash updates the row in place (running → success)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const component = new ToolExecutionComponent(
			"bash",
			"t-bash-7",
			{ command: "npm test" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		vi.setSystemTime(new Date("2026-01-01T00:00:12.000Z"));
		component.updateResult(bashResult("running output", undefined, false), true);

		const running = render(component);
		expect(running).toContain("●");
		expect(running).toContain("running");
		expect(running).toContain("12.0s");
		expect(running).not.toContain("running output");

		vi.setSystemTime(new Date("2026-01-01T00:00:25.000Z"));
		component.updateResult(bashResult("done", undefined, false), false);

		const settled = render(component);
		expect(settled).toContain("✓");
		expect(settled).toContain("25.0s");
		expect(settled).not.toContain("running");
		expect(settled).not.toContain("done");
	});

	test("expanding after a compact render does not lose the underlying result", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"t-bash-8",
			{ command: "cat file" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(bashResult("full content line\nsecond line", undefined, false), false);
		expect(render(component)).not.toContain("full content line");

		component.setExpanded(true);
		expect(render(component)).toContain("full content line");
		expect(render(component)).toContain("second line");
	});

	test("ls/find/grep render compact rows with bounded counts", () => {
		const cases: Array<{
			name: string;
			args: Record<string, unknown>;
			def: ReturnType<typeof createLsToolDefinition>;
			output: string;
			count: string;
		}> = [
			{
				name: "ls",
				args: { path: "src" },
				def: createLsToolDefinition(process.cwd()),
				output: "a.ts\nb.ts\nc.ts\n",
				count: "3 entries",
			},
			{
				name: "find",
				args: { pattern: "*.ts", path: "src" },
				def: createFindToolDefinition(process.cwd()),
				output: "src/a.ts\nsrc/b.ts\n",
				count: "2 results",
			},
			{
				name: "grep",
				args: { pattern: "TODO", path: "src" },
				def: createGrepToolDefinition(process.cwd()),
				output: "src/a.ts:1: TODO fix\nsrc/b.ts:2: TODO later\n",
				count: "2 matches",
			},
		];
		for (const scenario of cases) {
			const component = new ToolExecutionComponent(
				scenario.name,
				`t-${scenario.name}-1`,
				scenario.args,
				{},
				scenario.def,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.output }], details: undefined, isError: false },
				false,
			);
			const rendered = render(component);
			expect(rendered).toContain(`✓ ${scenario.name}`);
			expect(rendered).toContain(scenario.count);
			expect(rendered).not.toContain("a.ts");
			expect(rendered.split("\n").length).toBe(1);
		}
	});

	test("backgrounded process_start renders a live managed-process row", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const stdout = new BoundedOutputBuffer(1024);
		const stderr = new BoundedOutputBuffer(1024);
		const request: AiraProcessRequest = { command: "npm run dev", cwd: process.cwd() };
		const record: AiraProcessRecord = {
			id: "proc-1",
			request,
			purpose: "dev",
			mode: "background",
			ownerSessionId: "session-1",
			createdAt: Date.parse("2026-01-01T00:00:00Z"),
			startedAt: Date.parse("2026-01-01T00:00:00Z"),
			pid: 4242,
			status: "running",
			stdout,
			stderr,
			exitPromise: Promise.resolve(null),
			exitPromiseResolve: () => {},
		};
		const records = new Map<string, AiraProcessRecord>([["proc-1", record]]);
		const manager: AiraProcessToolRuntime = {
			sessionCwd: process.cwd(),
			start: async () => {
				throw new Error("unused");
			},
			get: (id) => records.get(id),
			list: () => [...records.values()],
			logs: () => undefined,
			terminate: async () => undefined,
		};
		const definitions = createAiraProcessToolDefinitions({
			manager,
			state: { project: { root: process.cwd() } } as never,
		});
		const result: AiraExecutionResult = {
			status: "backgrounded",
			ok: true,
			command: "npm run dev",
			cwd: process.cwd(),
			startedAt: 0,
			durationMs: 12,
			processId: "proc-1",
			stdout: { text: "", truncated: false },
			stderr: { text: "", truncated: false },
		};
		const component = new ToolExecutionComponent(
			"process_start",
			"t-proc-1",
			{ command: "npm run dev", background: true, purpose: "dev" },
			{},
			definitions.process_start,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Started managed process proc-1 (npm run dev)" }],
				details: { processId: "proc-1", result },
				isError: false,
			},
			false,
		);

		vi.setSystemTime(new Date("2026-01-01T00:03:12.000Z"));
		component.invalidate();
		const rendered = render(component);
		expect(rendered).toContain("●");
		expect(rendered).toContain("process");
		expect(rendered).toContain("npm run dev");
		expect(rendered).toContain("running");
		expect(rendered).toContain("3m12s");
		expect(rendered).toContain("pid 4242");

		// Settle the record: the row swaps to a terminal state and stops polling.
		record.status = "exited";
		record.exitCode = 0;
		record.exitedAt = Date.parse("2026-01-01T00:01:00Z");
		component.invalidate();
		const settled = render(component);
		expect(settled).toContain("✓");
		expect(settled).toContain("1m00s");
		expect(settled).not.toContain("running");
	});

	test("failed foreground process_start shows exit code and stderr tail", () => {
		const result: AiraExecutionResult = {
			status: "exited",
			ok: false,
			command: "npm test",
			cwd: process.cwd(),
			startedAt: 0,
			durationMs: 4500,
			exitCode: 1,
			stdout: { text: "some stdout\n", truncated: false },
			stderr: { text: "npm error\nCommand failed\n", truncated: false },
		};
		const manager: AiraProcessToolRuntime = {
			sessionCwd: process.cwd(),
			start: async () => {
				throw new Error("unused");
			},
			get: () => undefined,
			list: () => [],
			logs: () => undefined,
			terminate: async () => undefined,
		};
		const definitions = createAiraProcessToolDefinitions({
			manager,
			state: { project: { root: process.cwd() } } as never,
		});
		const component = new ToolExecutionComponent(
			"process_start",
			"t-proc-2",
			{ command: "npm test" },
			{},
			definitions.process_start,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Command failed: exit code 1 · 4.5s" }],
				details: { result },
				isError: false,
			},
			false,
		);

		const rendered = render(component);
		expect(rendered).toContain("✕");
		expect(rendered).toContain("exit 1");
		expect(rendered).toContain("4.5s");
		expect(rendered).toContain("Command failed");
		expect(rendered).not.toContain("some stdout");
	});

	test("process_stop renders a semantic terminated row", () => {
		const manager: AiraProcessToolRuntime = {
			sessionCwd: process.cwd(),
			start: async () => {
				throw new Error("unused");
			},
			get: () => undefined,
			list: () => [],
			logs: () => undefined,
			terminate: async () => undefined,
		};
		const definitions = createAiraProcessToolDefinitions({
			manager,
			state: { project: { root: process.cwd() } } as never,
		});
		const component = new ToolExecutionComponent(
			"process_stop",
			"t-proc-3",
			{ id: "proc-1" },
			{},
			definitions.process_stop,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "process proc-1 terminated after 3m12s" }],
				details: { processId: "proc-1" },
				isError: false,
			},
			false,
		);

		const rendered = render(component);
		expect(rendered).toContain("✓");
		expect(rendered).toContain("process stop");
		expect(rendered).toContain("proc-1");
		expect(rendered).toContain("terminated");
		expect(rendered).toContain("3m12s");
	});

	test("consecutive successful reads group into one row with sub-lines", () => {
		const container = new Container();
		const def = createReadToolDefinition(process.cwd());
		const first = new ToolExecutionComponent(
			"read",
			"r1",
			{ path: "workbench.ts" },
			{},
			def,
			createFakeTui(),
			process.cwd(),
		);
		first.updateResult({ content: [{ type: "text", text: "hidden-a" }], details: undefined, isError: false }, false);
		container.addChild(first);

		const second = new ToolExecutionComponent(
			"read",
			"r2",
			{ path: "projection.ts" },
			{},
			def,
			createFakeTui(),
			process.cwd(),
		);
		expect(tryGroupToolComponent(container, second)).toBe(true);

		expect(container.children.length).toBe(1);
		expect(container.children[0]).toBeInstanceOf(ToolExecutionGroup);
		const rendered = stripAnsi(container.render(120).join("\n"));
		expect(rendered).toContain("✓ read");
		expect(rendered).toContain("2 files");
		expect(rendered).toContain("workbench.ts");
		expect(rendered).toContain("projection.ts");
		expect(rendered).not.toContain("hidden-a");

		// Settling the second member succeeds: the group stays.
		second.updateResult({ content: [{ type: "text", text: "hidden-b" }], details: undefined, isError: false }, false);
		expect(container.children.length).toBe(1);
	});

	test("a group dissolves when a member settles with an error", () => {
		const container = new Container();
		const def = createReadToolDefinition(process.cwd());
		const first = new ToolExecutionComponent("read", "r1", { path: "a.ts" }, {}, def, createFakeTui(), process.cwd());
		first.updateResult({ content: [{ type: "text", text: "a" }], details: undefined, isError: false }, false);
		container.addChild(first);

		const second = new ToolExecutionComponent(
			"read",
			"r2",
			{ path: "b.ts" },
			{},
			def,
			createFakeTui(),
			process.cwd(),
		);
		tryGroupToolComponent(container, second);
		expect(container.children[0]).toBeInstanceOf(ToolExecutionGroup);

		second.updateResult({ content: [{ type: "text", text: "boom" }], details: undefined, isError: true }, false);

		expect(container.children.length).toBe(2);
		expect(container.children[0]).toBeInstanceOf(ToolExecutionComponent);
		expect(container.children[1]).toBeInstanceOf(ToolExecutionComponent);
		const rendered = stripAnsi(container.render(120).join("\n"));
		expect(rendered).toContain("✕ read");
		expect(rendered).toContain("boom");
	});

	test("expanding a group reveals every member's full output", () => {
		const container = new Container();
		const def = createReadToolDefinition(process.cwd());
		const first = new ToolExecutionComponent("read", "r1", { path: "a.ts" }, {}, def, createFakeTui(), process.cwd());
		first.updateResult({ content: [{ type: "text", text: "content-a" }], details: undefined, isError: false }, false);
		container.addChild(first);
		const second = new ToolExecutionComponent(
			"read",
			"r2",
			{ path: "b.ts" },
			{},
			def,
			createFakeTui(),
			process.cwd(),
		);
		second.updateResult(
			{ content: [{ type: "text", text: "content-b" }], details: undefined, isError: false },
			false,
		);
		tryGroupToolComponent(container, second);

		const group = container.children[0] as ToolExecutionGroup;
		group.setExpanded(true);
		const rendered = stripAnsi(container.render(120).join("\n"));
		expect(rendered).toContain("2 files");
		expect(rendered).toContain("content-a");
		expect(rendered).toContain("content-b");

		group.setExpanded(false);
		const collapsed = stripAnsi(container.render(120).join("\n"));
		expect(collapsed).not.toContain("content-a");
	});

	test("a pending member never becomes the group tail for further joins", () => {
		const container = new Container();
		const def = createReadToolDefinition(process.cwd());
		const first = new ToolExecutionComponent("read", "r1", { path: "a.ts" }, {}, def, createFakeTui(), process.cwd());
		first.updateResult({ content: [{ type: "text", text: "a" }], details: undefined, isError: false }, false);
		container.addChild(first);
		// A pending read may join (its failure dissolves the group), but the
		// group refuses further joins while its tail member is unsettled.
		const second = new ToolExecutionComponent(
			"read",
			"r2",
			{ path: "b.ts" },
			{},
			def,
			createFakeTui(),
			process.cwd(),
		);
		expect(tryGroupToolComponent(container, second)).toBe(true);
		const third = new ToolExecutionComponent("read", "r3", { path: "c.ts" }, {}, def, createFakeTui(), process.cwd());
		expect(tryGroupToolComponent(container, third)).toBe(false);
		container.addChild(third);
		expect(container.children.length).toBe(2);
	});

	test("different tools never group", () => {
		const container = new Container();
		const readDef = createReadToolDefinition(process.cwd());
		const lsDef = createLsToolDefinition(process.cwd());
		const first = new ToolExecutionComponent(
			"read",
			"r1",
			{ path: "a.ts" },
			{},
			readDef,
			createFakeTui(),
			process.cwd(),
		);
		first.updateResult({ content: [{ type: "text", text: "a" }], details: undefined, isError: false }, false);
		container.addChild(first);
		const ls = new ToolExecutionComponent("ls", "l1", { path: "src" }, {}, lsDef, createFakeTui(), process.cwd());
		expect(tryGroupToolComponent(container, ls)).toBe(false);
	});

	test("settled batch members regroup into the previous group after results arrive", () => {
		const container = new Container();
		const def = createReadToolDefinition(process.cwd());
		// All call rows are added while pending (a single model message with
		// several tool calls), so add-time grouping cannot fire.
		const first = new ToolExecutionComponent("read", "r1", { path: "a.ts" }, {}, def, createFakeTui(), process.cwd());
		const second = new ToolExecutionComponent(
			"read",
			"r2",
			{ path: "b.ts" },
			{},
			def,
			createFakeTui(),
			process.cwd(),
		);
		const third = new ToolExecutionComponent("read", "r3", { path: "c.ts" }, {}, def, createFakeTui(), process.cwd());
		container.addChild(first);
		container.addChild(second);
		container.addChild(third);
		expect(container.children.length).toBe(3);

		// Results settle in order; each successful settle folds into the group.
		first.updateResult({ content: [{ type: "text", text: "a" }], details: undefined, isError: false }, false);
		regroupToolComponent(container, first);
		expect(container.children.length).toBe(3);

		second.updateResult({ content: [{ type: "text", text: "b" }], details: undefined, isError: false }, false);
		regroupToolComponent(container, second);
		expect(container.children.length).toBe(2);
		expect(container.children[0]).toBeInstanceOf(ToolExecutionGroup);

		third.updateResult({ content: [{ type: "text", text: "c" }], details: undefined, isError: false }, false);
		regroupToolComponent(container, third);
		expect(container.children.length).toBe(1);
		const rendered = stripAnsi(container.render(120).join("\n"));
		expect(rendered).toContain("3 files");
		expect(rendered).toContain("a.ts");
		expect(rendered).toContain("b.ts");
		expect(rendered).toContain("c.ts");
	});

	test("dissolveGroupFrom restores standalone rows at the same position", () => {
		const container = new Container();
		const def = createReadToolDefinition(process.cwd());
		const first = new ToolExecutionComponent("read", "r1", { path: "a.ts" }, {}, def, createFakeTui(), process.cwd());
		first.updateResult({ content: [{ type: "text", text: "a" }], details: undefined, isError: false }, false);
		container.addChild(first);
		const second = new ToolExecutionComponent(
			"read",
			"r2",
			{ path: "b.ts" },
			{},
			def,
			createFakeTui(),
			process.cwd(),
		);
		tryGroupToolComponent(container, second);
		const group = container.children[0] as ToolExecutionGroup;
		expect(group.getMembers().length).toBe(2);

		dissolveGroupFrom(container, group);
		expect(container.children.length).toBe(2);
		expect(group.getMembers().length).toBe(0);
		// Post-dissolve errors must not re-trigger dissolution.
		second.updateResult({ content: [{ type: "text", text: "boom" }], details: undefined, isError: true }, false);
		expect(container.children.length).toBe(2);
	});
});
