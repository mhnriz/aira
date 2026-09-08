import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { MissingSessionCwdError } from "../../src/core/session-cwd.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

/**
 * Prototype-call harness: exercises the REAL private methods of
 * InteractiveMode against a narrow fake host context (same pattern as
 * test/suite/regressions/5943-session-start-notify.test.ts). The input
 * layer itself is covered by the keybinding and CustomEditor tests; here we
 * verify the wiring and the success-only, count-carrying notices.
 */

type KeyHandlersContext = {
	defaultEditor: {
		onAction: ReturnType<typeof vi.fn>;
		onEscape?: unknown;
		onCtrlD: unknown;
		onChange: unknown;
		onPasteImage?: unknown;
		onContextualLeftArrow?: unknown;
		onSubmit?: unknown;
	};
	session: { isStreaming: boolean; isBashRunning: boolean };
	settingsManager: { getDoubleEscapeAction: () => string };
	editor: { getText: () => string; setText: ReturnType<typeof vi.fn> };
	ui: { onDebug?: unknown; requestRender: ReturnType<typeof vi.fn> };
	workbench?: {
		resizeBy: ReturnType<typeof vi.fn>;
		isVisibleNow: () => boolean;
		toggle?: ReturnType<typeof vi.fn>;
	};
	showStatus: ReturnType<typeof vi.fn>;
};

type ResumeContext = {
	clearStatusIndicator: ReturnType<typeof vi.fn>;
	runtimeHost: {
		switchSession: (path: string, options?: unknown) => Promise<{ cancelled: boolean }>;
	};
	session: { messages: AgentMessage[] };
	showStatus: ReturnType<typeof vi.fn>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	handleFatalRuntimeError: (message: string, error: unknown) => { cancelled: boolean };
};

const prototype = InteractiveMode.prototype as unknown as {
	setupKeyHandlers(this: KeyHandlersContext): void;
	handleResumeSession(this: ResumeContext, sessionPath: string, options?: unknown): Promise<{ cancelled: boolean }>;
	sessionCountLabel(this: { session: { messages: AgentMessage[] } }): string;
};

/** Wire the fake host object up to the real private methods of the class. */
function asInteractiveMode<T extends object>(ctx: T): T {
	Object.setPrototypeOf(ctx, InteractiveMode.prototype);
	return ctx;
}

function makeKeyHandlersContext(): KeyHandlersContext {
	return asInteractiveMode({
		defaultEditor: {
			onAction: vi.fn(),
			onCtrlD: vi.fn(),
			onChange: vi.fn(),
		},
		session: { isStreaming: false, isBashRunning: false },
		settingsManager: { getDoubleEscapeAction: () => "none" },
		editor: { getText: () => "", setText: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
	});
}

describe("Engineering Context keyboard resize wiring", () => {
	it("registers wider/narrower handlers next to the Workbench toggle", () => {
		const ctx = makeKeyHandlersContext();
		prototype.setupKeyHandlers.call(ctx);
		const actions = ctx.defaultEditor.onAction.mock.calls.map(([action]) => action) as string[];
		expect(actions).toContain("app.workbench.toggle");
		expect(actions).toContain("app.workbench.wider");
		expect(actions).toContain("app.workbench.narrower");
	});

	it("wider handler resizes the controller by +4 and reports the new width", () => {
		const ctx = makeKeyHandlersContext();
		ctx.workbench = {
			resizeBy: vi.fn((delta: number) => 42 + delta),
			isVisibleNow: () => true,
		};
		prototype.setupKeyHandlers.call(ctx);
		const handler = ctx.defaultEditor.onAction.mock.calls.find(
			([action]) => action === "app.workbench.wider",
		)?.[1] as () => void;
		handler();
		expect(ctx.workbench?.resizeBy).toHaveBeenCalledWith(4);
		expect(ctx.showStatus).toHaveBeenCalledWith("Engineering Context 46 cols");
	});

	it("narrower handler resizes the controller by -4 and reports the new width", () => {
		const ctx = makeKeyHandlersContext();
		ctx.workbench = {
			resizeBy: vi.fn((delta: number) => 42 + delta),
			isVisibleNow: () => true,
		};
		prototype.setupKeyHandlers.call(ctx);
		const handler = ctx.defaultEditor.onAction.mock.calls.find(
			([action]) => action === "app.workbench.narrower",
		)?.[1] as () => void;
		handler();
		expect(ctx.workbench?.resizeBy).toHaveBeenCalledWith(-4);
		expect(ctx.showStatus).toHaveBeenCalledWith("Engineering Context 38 cols");
	});

	it("reports hidden state when the sidebar is auto-hidden (narrow terminal)", () => {
		const ctx = makeKeyHandlersContext();
		ctx.workbench = {
			resizeBy: vi.fn((delta: number) => 42 + delta),
			isVisibleNow: () => false,
		};
		prototype.setupKeyHandlers.call(ctx);
		const handler = ctx.defaultEditor.onAction.mock.calls.find(
			([action]) => action === "app.workbench.wider",
		)?.[1] as () => void;
		handler();
		expect(ctx.showStatus).toHaveBeenCalledWith("hidden · Engineering Context 46 cols");
	});

	it("toggle handler still drives the controller toggle", () => {
		const ctx = makeKeyHandlersContext();
		const toggle = vi.fn();
		ctx.workbench = { resizeBy: vi.fn(), isVisibleNow: () => true, toggle };
		prototype.setupKeyHandlers.call(ctx);
		const handler = ctx.defaultEditor.onAction.mock.calls.find(
			([action]) => action === "app.workbench.toggle",
		)?.[1] as () => void;
		handler();
		expect(toggle).toHaveBeenCalled();
	});
});

function makeResumeContext(overrides: Partial<ResumeContext> = {}): ResumeContext {
	return asInteractiveMode({
		clearStatusIndicator: vi.fn(),
		runtimeHost: {
			switchSession: vi.fn(async () => ({ cancelled: false })),
		},
		session: { messages: [] },
		showStatus: vi.fn(),
		promptForMissingSessionCwd: vi.fn(async () => undefined),
		handleFatalRuntimeError: vi.fn(() => ({ cancelled: true })),
		...overrides,
	});
}

describe("session transition feedback", () => {
	it("sessionCountLabel pluralizes and counts in-memory messages only", () => {
		expect(prototype.sessionCountLabel.call({ session: { messages: [] } })).toBe("0 messages");
		expect(
			prototype.sessionCountLabel.call({ session: { messages: [{} as AgentMessage, {} as AgentMessage] } }),
		).toBe("2 messages");
		expect(prototype.sessionCountLabel.call({ session: { messages: [{} as AgentMessage] } })).toBe("1 message");
	});

	it("shows a counted notice after a successful resume", async () => {
		const ctx = makeResumeContext({
			session: { messages: [{} as AgentMessage, {} as AgentMessage, {} as AgentMessage] },
		});
		const result = await prototype.handleResumeSession.call(ctx, "/some/session.json");
		expect(result.cancelled).toBe(false);
		expect(ctx.showStatus).toHaveBeenCalledWith("Resumed session · 3 messages");
	});

	it("stays silent when the user cancels the resume", async () => {
		const ctx = makeResumeContext({
			runtimeHost: {
				switchSession: vi.fn(async () => ({ cancelled: true })),
			},
		});
		const result = await prototype.handleResumeSession.call(ctx, "/some/session.json");
		expect(result.cancelled).toBe(true);
		expect(ctx.showStatus).not.toHaveBeenCalled();
	});

	it("handles the missing-cwd flow with a cwd-context notice", async () => {
		const missing = new MissingSessionCwdError({
			sessionFile: "/some/session.json",
			sessionCwd: "/gone/cwd",
			fallbackCwd: "/home/user/project",
		});
		const ctx = makeResumeContext({
			runtimeHost: {
				switchSession: vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce({ cancelled: false }),
			},
			session: { messages: [{} as AgentMessage] },
			promptForMissingSessionCwd: vi.fn(async () => "/selected/cwd"),
		});
		const result = await prototype.handleResumeSession.call(ctx, "/some/session.json");
		expect(result.cancelled).toBe(false);
		expect(ctx.showStatus).toHaveBeenCalledWith("Resumed session in current cwd · 1 message");
	});

	it("reports resume-cancelled and no success notice when the user declines the cwd prompt", async () => {
		const missing = new MissingSessionCwdError({
			sessionFile: "/some/session.json",
			sessionCwd: "/gone/cwd",
			fallbackCwd: "/home/user/project",
		});
		const ctx = makeResumeContext({
			runtimeHost: {
				switchSession: vi.fn().mockRejectedValue(missing),
			},
			promptForMissingSessionCwd: vi.fn(async () => undefined),
		});
		const result = await prototype.handleResumeSession.call(ctx, "/some/session.json");
		expect(result.cancelled).toBe(true);
		expect(ctx.showStatus).toHaveBeenCalledWith("Resume cancelled");
	});

	it("delegates unexpected errors to the fatal-error path", async () => {
		const boom = new Error("boom");
		const ctx = makeResumeContext({
			runtimeHost: {
				switchSession: vi.fn().mockRejectedValue(boom),
			},
		});
		await prototype.handleResumeSession.call(ctx, "/some/session.json");
		expect(ctx.handleFatalRuntimeError).toHaveBeenCalledWith("Failed to resume session", boom);
		expect(ctx.showStatus).not.toHaveBeenCalled();
	});
});
