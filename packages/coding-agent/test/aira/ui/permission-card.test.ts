/**
 * Aira permission card — render + interaction tests (Phase 12.x).
 *
 * The card is the interactive projection of the canonical permission
 * presentation. Tests here render the component at real widths (a plain
 * Container.render is ANSI-styled, token-free) and drive keyboard input:
 * navigation, Enter select, Esc cancel, and the optional timeout expiry
 * (which resolves exactly like the extension selector's — cancel).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiraPermissionPresentation } from "../../../src/aira/permissions/presentation.ts";
import {
	type PermissionCardChoice,
	PermissionCardComponent,
} from "../../../src/modes/interactive/components/permission-card.ts";
import { setTheme } from "../../../src/modes/interactive/theme/theme.ts";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function plain(text: string): string {
	return text.replace(ANSI, "");
}

const CHOICES: PermissionCardChoice[] = [
	{ id: "allow-once", label: "Allow once", description: "Run only this request" },
	{ id: "allow-session", label: "Allow session", description: "Approve this exact subject for this session" },
	{ id: "allow-always", label: "Allow always", description: "Persist approval for this exact subject" },
	{ id: "deny", label: "Deny", description: "Do not execute" },
];

function bashPresentation(): AiraPermissionPresentation {
	return {
		tool: "bash",
		capability: "process",
		operation: "Shell command",
		subject: "git push --dry-run origin main",
		redacted: false,
		reason: "remote repository operation",
		details: [{ label: "Working directory", value: "~/proj/aira" }],
		summary: "git push --dry-run origin main",
	};
}

function makeCard(
	presentation: AiraPermissionPresentation = bashPresentation(),
	onSelect = vi.fn(),
	onCancel = vi.fn(),
) {
	const card = new PermissionCardComponent(presentation, CHOICES, onSelect, onCancel);
	return { card, onSelect, onCancel };
}

describe("Aira permission card (Phase 12.x)", () => {
	beforeAll(() => {
		expect(setTheme("aira-zhr").success).toBe(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the heading, operation, actual command, metadata, and reason", () => {
		const { card } = makeCard();
		const lines = card.render(80).map(plain);
		expect(lines.some((line) => line.includes("PERMISSION"))).toBe(true);
		expect(lines.some((line) => line.includes("Shell command"))).toBe(true);
		expect(lines.some((line) => line.includes("$ git push --dry-run origin main"))).toBe(true);
		expect(lines.some((line) => line.includes("Working directory"))).toBe(true);
		expect(lines.some((line) => line.includes("~/proj/aira"))).toBe(true);
		expect(lines.some((line) => line.includes("Reason"))).toBe(true);
		expect(lines.some((line) => line.includes("remote repository operation"))).toBe(true);
	});

	it("renders every approval scope with its description, including Deny", () => {
		const { card } = makeCard();
		const text = card.render(80).map(plain).join("\n");
		expect(text).toContain("Allow once");
		expect(text).toContain("Run only this request");
		expect(text).toContain("Allow session");
		expect(text).toContain("Approve this exact subject for this session");
		expect(text).toContain("Allow always");
		expect(text).toContain("Persist approval for this exact subject");
		expect(text).toContain("Deny");
		expect(text).toContain("Do not execute");
		// The generic question text never appears in the card.
		expect(text).not.toContain("Allow bash to run");
	});

	it("marks the focused choice; arrow keys move focus and Enter selects its id", () => {
		const { card, onSelect } = makeCard();
		const initial = card.render(80).map(plain).join("\n");
		expect(initial.includes("› Allow once")).toBe(true);
		expect(initial.includes("› Allow session")).toBe(false);
		card.handleInput("\x1b[B");
		const afterDown = card.render(80).map(plain).join("\n");
		expect(afterDown.includes("› Allow session")).toBe(true);
		expect(afterDown.includes("› Allow once")).toBe(false);
		card.handleInput("\x1b[B");
		card.handleInput("\x1b[B");
		card.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith("deny");
	});

	it("Esc cancels (same resolution path as the extension selector)", () => {
		const { card, onCancel } = makeCard();
		card.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("timeout expiry cancels through the same callback", () => {
		vi.useFakeTimers();
		const { card, onCancel } = makeCard();
		const fakeTui = { requestRender: () => {} };
		const timed = new PermissionCardComponent(bashPresentation(), CHOICES, vi.fn(), onCancel, {
			tui: fakeTui as never,
			timeout: 1000,
		});
		vi.advanceTimersByTime(1500);
		expect(onCancel).toHaveBeenCalledTimes(1);
		timed.dispose();
		card.dispose();
		vi.useRealTimers();
	});

	it("narrow terminals: every line fits the width and the command truncates visibly", () => {
		const long = `git commit -am ${JSON.stringify("x".repeat(200))}`;
		const { card } = makeCard({
			...bashPresentation(),
			subject: long,
			summary: long,
		});
		const width = 30;
		const lines = card.render(width);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			// ANSI codes excluded; visible width must not overflow the terminal.
			const visible = line.replace(ANSI, "");
			expect(visible.length, visible).toBeLessThanOrEqual(width);
		}
		const text = lines.map(plain).join("\n");
		expect(text).toContain("…");
		expect(text).toContain("Allow once");
		expect(text).toContain("Deny");
		expect(text).toContain("↑↓");
	});

	it("out-of-workspace write renders target and scope rows", () => {
		const { card } = makeCard({
			tool: "write",
			capability: "mutating",
			operation: "Write file",
			subject: "/etc/nginx/nginx.conf",
			redacted: false,
			reason: "write outside workspace",
			details: [
				{ label: "Target", value: "/etc/nginx/nginx.conf" },
				{ label: "Scope", value: "outside workspace" },
			],
			outsideWorkspace: true,
			summary: "/etc/nginx/nginx.conf",
		});
		const text = card.render(80).map(plain).join("\n");
		expect(text).toContain("Write file");
		expect(text).toContain("/etc/nginx/nginx.conf");
		expect(text).toContain("outside workspace");
		expect(text).toContain("write outside workspace");
	});

	it("flat 'k'/'j' navigation works like the extension selector", () => {
		const { card, onSelect } = makeCard();
		card.handleInput("j");
		card.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("allow-session");
	});
});
