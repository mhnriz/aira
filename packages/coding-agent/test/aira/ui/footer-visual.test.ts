import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import { FooterComponent } from "../../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const BG_ESCAPE = /\x1b\[48/;

function createSession(overrides: { mode?: string } = {}): AgentSession {
	const session = {
		airaSessionState: {
			mode: overrides.mode ?? "build",
		},
		state: {
			model: {
				id: "test-model",
				provider: "test",
				contextWindow: 200_000,
				reasoning: false,
			},
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingSubscription: () => false,
		},
	};
	return session as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	} as ReadonlyFooterDataProvider;
}

describe("Aira footer visual treatment (aira-zhr)", () => {
	beforeAll(() => {
		initTheme("aira-zhr", false);
	});

	it("no longer paints the old gray status-strip fill", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		const lines = footer.render(120);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line).not.toMatch(BG_ESCAPE);
		}
	});

	it("keeps the compact segment hierarchy on the terminal background", () => {
		const footer = new FooterComponent(createSession({ mode: "build" }), createFooterData());
		const plain = footer.render(120)[0]!.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		expect(plain).toContain("BUILD");
		expect(plain).toContain("test-model");
		expect(plain).toContain("12.3%");
	});
});
