/**
 * Aira interaction — manager tests (Phase 11).
 *
 * Covers: ask/answer lifecycle, single-pending constraint, UI attach
 * semantics (headless resolve unavailable), abort cancel, timeout,
 * dispose-on-shutdown truthfulness, supersede, bounded snapshots,
 * goal seam notifications, and zero fabricated answers.
 */
import { describe, expect, it } from "vitest";
import { createAiraInteractionManager } from "../../../src/aira/interaction/manager.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

function makeManager(goalNotifications: Array<Record<string, string>> = []) {
	const state = acquireAiraSessionState("interaction-test");
	const manager = createAiraInteractionManager(state, {
		goal: {
			considerUserInteraction: (change) => goalNotifications.push({ ...change }),
		},
	});
	return { state, manager, goalNotifications };
}

describe("AiraInteractionManager (Phase 11)", () => {
	it("resolves a semantic question through the UI bridge with selections", async () => {
		const { state, manager, goalNotifications } = makeManager();
		manager.attachUI();
		const pending = manager.ask({
			type: "semantic",
			question: "Which auth approach?",
			choices: [
				{ id: "jwt", label: "JWT" },
				{ id: "session", label: "Sessions" },
			],
			freeform: false,
			owner: "agent",
		});
		const snapshot = manager.status();
		expect(snapshot.pending).toBe(true);
		expect(snapshot.question?.prompt).toBe("Which auth approach?");
		expect(snapshot.question?.choicesCount).toBe(2);
		expect(snapshot.question?.owner).toBe("agent");
		expect(state.interaction?.pending).toBe(true);
		expect(goalNotifications).toContainEqual({
			type: "semantic",
			state: "pending",
			prompt: "Which auth approach?",
			detail: "agent",
		});

		const answered = manager.answer(snapshot.question!.interactionId, {
			resolution: "answered",
			selections: ["jwt"],
		});
		expect(answered).toBe(true);
		const result = await pending;
		expect(result.resolution).toBe("answered");
		expect(result.selections).toEqual(["jwt"]);
		expect(result.interactionId).toBe(snapshot.question!.interactionId);
		expect(manager.status().pending).toBe(false);
		expect(goalNotifications).toContainEqual({
			type: "semantic",
			state: "answered",
			prompt: "Which auth approach?",
			detail: "agent",
		});
	});

	it("accepts a freeform answer", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		const pending = manager.ask({ type: "semantic", question: "Any notes?", freeform: true });
		const snapshot = manager.status();
		manager.answer(snapshot.question!.interactionId, { resolution: "answered", selections: [], text: "use JWT" });
		const result = await pending;
		expect(result.text).toBe("use JWT");
		expect(result.selections).toEqual([]);
	});

	it("cancellation never fabricates selections or text", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		const pending = manager.ask({ type: "semantic", question: "Should I proceed?", freeform: true });
		const snapshot = manager.status();
		manager.answer(snapshot.question!.interactionId, { resolution: "cancelled", selections: [] });
		const result = await pending;
		expect(result.resolution).toBe("cancelled");
		expect(result.selections).toEqual([]);
		expect(result.text).toBeUndefined();
		expect(result.decision).toBeUndefined();
	});

	it("permission answers carry the decision; semantics never do", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		const pending = manager.ask({
			type: "permission",
			question: "Allow bash?",
			choices: [
				{ id: "allow-once", label: "Allow once" },
				{ id: "deny", label: "Deny" },
			],
			freeform: false,
			owner: "permission:bash",
		});
		const snapshot = manager.status();
		expect(snapshot.question?.type).toBe("permission");
		manager.answer(snapshot.question!.interactionId, {
			resolution: "answered",
			selections: [],
			decision: "allow-once",
		});
		const result = await pending;
		expect(result.decision).toBe("allow-once");
		expect(result.type).toBe("permission");
	});

	it("headless sessions resolve immediately as unavailable without asking", async () => {
		const { manager } = makeManager();
		const result = await manager.ask({ type: "semantic", question: "Do you want this?" });
		expect(result.resolution).toBe("unavailable");
		expect(result.selections).toEqual([]);
		// The closed history reflects the truthful outcome.
		expect(manager.status().recentClosed[0]?.resolution).toBe("unavailable");
	});

	it("a second question while one is pending is superseded (no stacked dialogs)", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		const first = manager.ask({ type: "semantic", question: "First?" });
		const second = await manager.ask({ type: "permission", question: "Second?" });
		expect(second.resolution).toBe("superseded");
		const snapshot = manager.status();
		manager.answer(snapshot.question!.interactionId, { resolution: "answered", selections: [] });
		await first;
		expect(manager.status().pending).toBe(false);
	});

	it("an abort signal cancels the pending question truthfully", async () => {
		const { manager, goalNotifications } = makeManager();
		manager.attachUI();
		const controller = new AbortController();
		const pending = manager.ask({ type: "semantic", question: "Wait for me?" }, controller.signal);
		controller.abort();
		const result = await pending;
		expect(result.resolution).toBe("cancelled");
		expect(goalNotifications).toContainEqual({ type: "semantic", state: "closed", prompt: "Wait for me?" });
	});

	it("an unanswered question with a timeout resolves timed-out (never an answer)", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		const pending = manager.ask({ type: "semantic", question: "Quick decision", timeoutMs: 20 });
		const result = await pending;
		expect(result.resolution).toBe("timed-out");
		expect(result.selections).toEqual([]);
	});

	it("session shutdown resolves a pending question without wedging the session", async () => {
		const { state, manager } = makeManager();
		manager.attachUI();
		const pending = manager.ask({ type: "permission", question: "Approve?" });
		manager.dispose();
		const result = await pending;
		expect(["unavailable", "cancelled"]).toContain(result.resolution);
		expect(manager.status().pending).toBe(false);
		expect(disposeAiraSessionState(state.sessionId, state)).toBe(true);
	});

	it("detachUI makes the next question resolve unavailable", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		manager.detachUI();
		const result = await manager.ask({ type: "semantic", question: "Anyone there?" });
		expect(result.resolution).toBe("unavailable");
		expect(manager.status().uiAttached).toBe(false);
	});

	it("bounded snapshots: closed history caps at 4 and prompts are truncated", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		const long = "x".repeat(2000);
		for (let index = 0; index < 6; index += 1) {
			const pending = manager.ask({ type: "semantic", question: `${long}${index}` });
			const snapshot = manager.status();
			manager.answer(snapshot.question!.interactionId, { resolution: "cancelled", selections: [] });
			await pending;
		}
		const status = manager.status();
		expect(status.recentClosed.length).toBeLessThanOrEqual(4);
		expect(status.recentClosed[0]!.prompt.length).toBeLessThanOrEqual(201);
	});

	it("permission presentation round-trips into the pending projection (UI-only, bounded)", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		const pending = manager.ask({
			type: "permission",
			question: "Allow bash to run?",
			choices: [{ id: "deny", label: "Deny" }],
			owner: "permission:bash",
			permission: {
				tool: "bash",
				capability: "process",
				operation: "Shell command",
				subject: "git push --dry-run origin main",
				redacted: false,
				reason: "remote repository operation",
				details: [{ label: "Working directory", value: "~/proj/aira" }],
				summary: "git push --dry-run origin main",
			},
		});
		const question = manager.status().question!;
		expect(question.permission?.subject).toBe("git push --dry-run origin main");
		expect(question.permission?.operation).toBe("Shell command");
		expect(question.permission?.reason).toBe("remote repository operation");
		expect(question.permission?.details).toEqual([{ label: "Working directory", value: "~/proj/aira" }]);

		// The answer carries only the decision — never the presentation.
		manager.answer(question.interactionId, { resolution: "answered", selections: [], decision: "deny" });
		const result = await pending;
		expect(result.decision).toBe("deny");
		expect(result).not.toHaveProperty("permission");
		expect(manager.status().pending).toBe(false);
	});

	it("permission presentation is defensively bounded during normalization", async () => {
		const { manager } = makeManager();
		manager.attachUI();
		const pending = manager.ask({
			type: "permission",
			question: "Allow bash to run?",
			permission: {
				tool: "x".repeat(500),
				capability: "process",
				operation: "o".repeat(500),
				subject: "s".repeat(2000),
				redacted: true,
				reason: "r".repeat(2000),
				details: Array.from({ length: 9 }, (_, index) => ({ label: `l${index}`, value: `v${index}` })),
				summary: "m".repeat(2000),
			},
		});
		const question = manager.status().question!.permission!;
		expect(question.tool.length).toBeLessThanOrEqual(40);
		expect(question.operation.length).toBeLessThanOrEqual(48);
		expect(question.subject.length).toBeLessThanOrEqual(400);
		expect(question.reason.length).toBeLessThanOrEqual(200);
		expect(question.summary.length).toBeLessThanOrEqual(60);
		expect(question.details.length).toBeLessThanOrEqual(4);
		expect(question.redacted).toBe(true);
		manager.answer(manager.status().question!.interactionId, { resolution: "cancelled", selections: [] });
		const result = await pending;
		expect(result.resolution).toBe("cancelled");
	});
});
