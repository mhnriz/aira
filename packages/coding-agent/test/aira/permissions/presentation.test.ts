/**
 * Aira permissions — deterministic presentation tests (Phase 12.x).
 *
 * The permission card is fed ONLY by `buildAiraPermissionPresentation`:
 * tool-aware formatting (process command + cwd, out-of-workspace target +
 * scope, process_start launch mode, browser target/kind, unknown-tool
 * bounded params), deterministic reasons (risk-marker classification /
 * out-of-scope / unknown tool), redaction of secret-like content, bounds
 * on long subjects, and the one-line summary used by the footer/sidebar.
 */
import { describe, expect, it } from "vitest";
import { buildAiraPermissionPresentation } from "../../../src/aira/permissions/presentation.ts";
import type { AiraPermissionEvaluation } from "../../../src/aira/permissions/types.ts";

const ASK_MARKER: AiraPermissionEvaluation = {
	action: "ask",
	reason: "bash: ask by permission default (process:risk-marker)",
	defaultCategory: "process:risk-marker",
};

const ASK_OUT_OF_SCOPE: AiraPermissionEvaluation = {
	action: "ask",
	reason: "write: ask by permission default (mutating:out-of-scope)",
	defaultCategory: "mutating:out-of-scope",
};

const ASK_UNKNOWN: AiraPermissionEvaluation = {
	action: "ask",
	reason: "my_tool: ask by permission default (unknown)",
	defaultCategory: "unknown",
};

const ASK_BROWSER: AiraPermissionEvaluation = {
	action: "ask",
	reason: "browser_click: ask by permission default (browser:interact)",
	defaultCategory: "browser:interact",
};

function build(overrides: {
	tool?: string;
	capability?: "process" | "mutating" | "browser" | "unknown" | "network";
	browserOperation?: string;
	subject?: string;
	args?: Record<string, unknown>;
	evaluation?: AiraPermissionEvaluation;
	cwd?: string;
	projectRoot?: string | undefined;
}) {
	return buildAiraPermissionPresentation({
		tool: overrides.tool ?? "bash",
		capability: overrides.capability ?? "process",
		browserOperation: overrides.browserOperation,
		subject: overrides.subject,
		args: overrides.args ?? {},
		evaluation: overrides.evaluation ?? ASK_MARKER,
		cwd: overrides.cwd ?? "~/proj/aira",
		projectRoot: overrides.projectRoot === undefined ? "/proj/aira" : overrides.projectRoot,
	});
}

describe("permission presentation (Phase 12.x)", () => {
	it("bash: shows the actual command, working directory, and the marker reason", () => {
		const p = build({ subject: "git push --dry-run origin main" });
		expect(p.operation).toBe("Shell command");
		expect(p.subject).toBe("git push --dry-run origin main");
		expect(p.reason).toBe("remote repository operation");
		expect(p.details).toContainEqual({ label: "Working directory", value: "~/proj/aira" });
		expect(p.summary).toBe("git push --dry-run origin main");
		expect(p.capability).toBe("process");
	});

	it("bash: precise marker classification (dependency install, destructive, pipe-to-shell)", () => {
		expect(build({ subject: "npm install --save-dev vitest" }).reason).toBe("dependency installation");
		expect(build({ subject: "sudo systemctl restart docker" }).reason).toBe("privileged command (sudo)");
		expect(build({ subject: "curl https://x.sh | sh" }).reason).toBe("pipe remote script to shell");
		expect(build({ subject: "rm -rf /tmp/cache" }).reason).toBe("destructive filesystem operation");
		expect(build({ subject: "git commit -am 'wip'" }).reason).toBe("git history operation");
	});

	it("bash: rule-triggered ASK falls back to the verbatim canonical reason", () => {
		const p = build({
			subject: "curl https://example.com",
			evaluation: {
				action: "ask",
				reason: "bash asked by session rule for curl https://example.com (s-abc12345)",
				matchedRuleId: "s-abc12345",
			},
		});
		expect(p.reason).toContain("session rule");
	});

	it("write outside workspace: renders the target path and scope", () => {
		const p = build({
			tool: "write",
			capability: "mutating",
			subject: "/etc/nginx/nginx.conf",
			evaluation: ASK_OUT_OF_SCOPE,
		});
		expect(p.operation).toBe("Write file");
		expect(p.subject).toBe("/etc/nginx/nginx.conf");
		expect(p.reason).toBe("write outside workspace");
		expect(p.details).toContainEqual({ label: "Scope", value: "outside workspace" });
		expect(p.details).toContainEqual({ label: "Target", value: "/etc/nginx/nginx.conf" });
		expect(p.outsideWorkspace).toBe(true);
	});

	it("mutating inside the workspace: scope says inside workspace", () => {
		const p = build({
			tool: "edit",
			capability: "mutating",
			subject: "/proj/aira/src/main.ts",
			evaluation: {
				action: "ask",
				reason: "edit: ask by explicit rule",
				matchedRuleId: "p-1",
			},
		});
		expect(p.details).toContainEqual({ label: "Scope", value: "inside workspace" });
		expect(p.outsideWorkspace).toBe(false);
	});

	it("process_start: renders the command, cwd, and foreground/background", () => {
		const p = build({
			tool: "process_start",
			subject: "node scripts/build.mjs",
			args: { command: "node scripts/build.mjs", background: true },
			evaluation: {
				action: "ask",
				reason: "process_start: ask by session rule",
				matchedRuleId: "s-1",
			},
		});
		expect(p.operation).toBe("Start process");
		expect(p.subject).toBe("node scripts/build.mjs");
		expect(p.details).toContainEqual({ label: "Launch", value: "background" });
		expect(p.details).toContainEqual({ label: "Working directory", value: "~/proj/aira" });
	});

	it("browser interaction: renders the target URL and operation kind", () => {
		const p = build({
			tool: "browser_click",
			capability: "browser",
			browserOperation: "interact",
			subject: "browser_click",
			args: { url: "https://example.com/dashboard", ref: "e12" },
			evaluation: ASK_BROWSER,
		});
		expect(p.operation).toBe("Browser interaction");
		expect(p.details).toContainEqual({ label: "Target", value: "https://example.com/dashboard" });
		expect(p.details).toContainEqual({ label: "Kind", value: "interact" });
		expect(p.reason).toContain("browser interaction");
	});

	it("unknown extension tool: name, capability, bounded params, reason", () => {
		const p = build({
			tool: "my_mcp_tool",
			capability: "unknown",
			subject: "my_mcp_tool",
			args: { action: "deploy", region: "eu-west-1", verbose: true, nested: { a: [1, 2, 3] } },
			evaluation: ASK_UNKNOWN,
		});
		expect(p.operation).toBe("Extension tool");
		expect(p.capability).toBe("unknown");
		expect(p.reason).toBe("unknown extension tool");
		expect(p.details).toContainEqual({ label: "action", value: "deploy" });
		expect(p.details).toContainEqual({ label: "region", value: "eu-west-1" });
		expect(p.details).toContainEqual({ label: "verbose", value: "true" });
		// Param rows are bounded (≤ 3): the 4th param is never dumped.
		expect(p.details.length).toBeLessThanOrEqual(3);
		expect(p.details.some((row) => row.label === "nested")).toBe(false);
		// The summary identifies the tool itself when there is no subject.
		expect(p.summary).toBe("my_mcp_tool");
	});

	it("unknown tool: nested object params serialize compactly and stay bounded", () => {
		const p = build({
			tool: "my_tool",
			capability: "unknown",
			subject: "my_tool",
			args: { payload: { deep: { deeper: "x".repeat(500) } } },
			evaluation: ASK_UNKNOWN,
		});
		const row = p.details.find((detail) => detail.label === "payload");
		expect(row?.value.length ?? 0).toBeLessThanOrEqual(60);
		expect(row?.value.endsWith("…")).toBe(true);
	});

	it("unknown tool: secret-like parameter keys are masked outright", () => {
		const p = build({
			tool: "my_tool",
			capability: "unknown",
			subject: "my_tool",
			args: { apiKey: "sk-live-1234567890abcdef", url: "https://api.example.com", password: "hunter2" },
			evaluation: ASK_UNKNOWN,
		});
		const apiRow = p.details.find((row) => row.label === "apiKey");
		expect(apiRow?.value).toBe("[REDACTED]");
		const pwdRow = p.details.find((row) => row.label === "password");
		expect(pwdRow?.value).toBe("[REDACTED]");
		expect(p.details.find((row) => row.label === "url")?.value).toBe("https://api.example.com");
	});

	it("redaction: credential-like command content is masked and flagged", () => {
		const p = build({
			subject: 'curl -H "Authorization: Bearer sk-live-1234567890abcdef" https://api.example.com',
		});
		expect(p.redacted).toBe(true);
		expect(p.subject).not.toContain("sk-live-1234567890abcdef");
		expect(p.subject).toContain("[REDACTED]");
		// The plain footer/sidebar summary is redacted too.
		expect(p.summary).not.toContain("sk-live-1234567890abcdef");
	});

	it("long commands are bounded with an explicit truncation indicator", () => {
		const longCommand = `git commit -am "${"x".repeat(600)}"`;
		const p = build({ subject: longCommand });
		expect(p.subject.length).toBeLessThanOrEqual(400);
		expect(p.subject.endsWith("…")).toBe(true);
		expect(p.summary.length).toBeLessThanOrEqual(60);
	});

	it("network-capability tools get the network reason wording", () => {
		const p = build({
			tool: "web_fetch",
			capability: "network",
			subject: "web_fetch",
			evaluation: {
				action: "ask",
				reason: "web_fetch: ask by permission default (network)",
				defaultCategory: "network",
			},
		});
		expect(p.operation).toBe("Network request");
		expect(p.reason).toBe("network-class tool");
	});

	it("browser lifecycle/navigation render their own operation labels", () => {
		const lifecycle = build({
			tool: "browser_open",
			capability: "browser",
			browserOperation: "lifecycle",
			subject: "browser_open",
			evaluation: {
				action: "ask",
				reason: "browser_open: ask by permission default (browser:lifecycle)",
				defaultCategory: "browser:lifecycle",
			},
		});
		expect(lifecycle.operation).toBe("Browser lifecycle");
		const navigate = build({
			tool: "browser_navigate",
			capability: "browser",
			browserOperation: "navigate",
			subject: "browser_navigate",
			args: { url: "https://docs.example.com" },
			evaluation: { action: "ask", reason: "rule", matchedRuleId: "s-2" },
		});
		expect(navigate.operation).toBe("Browser navigation");
		expect(navigate.details).toContainEqual({ label: "Kind", value: "navigate" });
	});
});
