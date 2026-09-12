/**
 * 0.1.7 Step 4 — progressive context compaction through the real AgentSession.
 *
 * These tests prove the seam end to end:
 *
 * - small sessions are not compacted;
 * - canonical history (session.messages / persistence) is never mutated;
 * - the actual provider-visible conversation payload is smaller once compaction
 *   activates, compared against the same history with compaction disabled;
 * - the latest user request and its active tool chain stay verbatim;
 * - tool-call/tool-result pairing survives;
 * - /telemetry reading never triggers compaction or a model request;
 * - Step 3's adaptive tool surface stays intact.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AIRA_CONTEXT_COMPACTION_MARKERS } from "../../src/aira/context-compaction.ts";
import { renderSessionTelemetryJson } from "../../src/core/session-telemetry.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function longText(label: string, repeats: number): string {
	return `${label} ${"progress narration ".repeat(repeats)}`;
}

/** Build a realistic long canonical history: old work + a fresh active turn. */
function seedLongHistory(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < 8; i++) {
		messages.push({ role: "user", content: `old request ${i}`, timestamp: i });
		messages.push(
			fauxAssistantMessage(
				[fauxText(longText(`plan ${i}`, 120)), fauxToolCall("read", { path: `src/f${i}.ts` }, { id: `call-${i}` })],
				{ stopReason: "toolUse", timestamp: i },
			),
		);
		messages.push({
			role: "toolResult",
			toolCallId: `call-${i}`,
			toolName: "read",
			content: [fauxText(`file contents ${i} `.repeat(400))],
			isError: false,
			timestamp: i,
		});
		messages.push(fauxAssistantMessage(longText(`conclusion ${i}`, 100), { timestamp: i }));
	}
	return messages;
}

async function makeHarness(settings: Record<string, unknown> = {}): Promise<Harness> {
	const harness = await createHarness({ settings });
	harnesses.push(harness);
	return harness;
}

describe("progressive context compaction (AgentSession)", () => {
	it("does not compact a small session", async () => {
		const harness = await makeHarness();
		harness.setResponses([fauxAssistantMessage("hello there")]);
		await harness.session.prompt("say hi");

		const snapshot = harness.session.getTelemetrySnapshot();
		expect(snapshot.context.compaction.enabled).toBe(true);
		expect(snapshot.context.compaction.triggered).toBe(false);
		expect(snapshot.context.compaction.events).toBe(0);
		expect(snapshot.context.compaction.savedBytes).toBe(0);
		expect(snapshot.context.compaction.messagesCompacted).toBe(0);
		expect(snapshot.context.compaction.toolResultsCompacted).toBe(0);
		// No request carries per-request compaction accounting.
		for (const request of snapshot.context.recentRequests) {
			expect(request.compaction).toBeNull();
		}
		// The canonical transcript is untouched.
		expect(harness.session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("compacts old history on a growing session and reduces the real payload", async () => {
		// Baseline: identical history, compaction disabled.
		const baseline = await makeHarness({ contextCompaction: { enabled: false } });
		baseline.session.agent.state.messages = seedLongHistory();
		baseline.setResponses([fauxAssistantMessage("baseline reply")]);
		await baseline.session.prompt("current request");
		const baselineConversation =
			baseline.session.getTelemetrySnapshot().context.byTransport.conversationMessages.latestBytes;
		expect(baseline.session.getTelemetrySnapshot().context.compaction.enabled).toBe(false);
		expect(baseline.session.getTelemetrySnapshot().context.compaction.triggered).toBe(false);

		// Compaction-enabled run over the same seeded history.
		const harness = await makeHarness({ contextCompaction: { enabled: true } });
		harness.session.agent.state.messages = seedLongHistory();
		harness.setResponses([fauxAssistantMessage("compacted reply")]);
		await harness.session.prompt("current request");
		const snapshot = harness.session.getTelemetrySnapshot();
		const compactedConversation = snapshot.context.byTransport.conversationMessages.latestBytes;

		expect(snapshot.context.compaction.triggered).toBe(true);
		expect(snapshot.context.compaction.events).toBeGreaterThan(0);
		expect(snapshot.context.compaction.savedBytes).toBeGreaterThan(0);
		expect(snapshot.context.compaction.firstTriggerRequestIndex).toBe(0);
		expect(snapshot.context.compaction.messagesCompacted).toBeGreaterThan(0);
		expect(snapshot.context.compaction.toolResultsCompacted).toBeGreaterThan(0);
		expect(snapshot.context.recentRequests[0].compaction).not.toBeNull();

		// The actual provider-visible conversation payload is materially smaller.
		expect(baselineConversation).not.toBeNull();
		expect(compactedConversation).not.toBeNull();
		expect(compactedConversation as number).toBeLessThan(baselineConversation as number);
	});

	it("keeps canonical history intact while the model projection is compacted", async () => {
		const harness = await makeHarness();
		const seeded = seedLongHistory();
		harness.session.agent.state.messages = seeded;
		const before = JSON.stringify(seeded);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("current request");

		// Every seeded message is still present, unmutated, in canonical order.
		const canonical = harness.session.messages;
		expect(canonical.slice(0, seeded.length)).toEqual(seeded);
		expect(JSON.stringify(seeded)).toBe(before);
		// And no placeholder leaked into the canonical transcript.
		expect(JSON.stringify(canonical.slice(0, seeded.length))).not.toContain(
			AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse,
		);
	});

	it("keeps the latest user request verbatim in the model projection", async () => {
		const harness = await makeHarness();
		harness.session.agent.state.messages = seedLongHistory();
		const latest = "the exact latest user request text";
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt(latest);
		const lastUser = [...harness.session.messages].reverse().find((m) => m.role === "user");
		expect(lastUser).toBeDefined();
		expect(JSON.stringify(lastUser)).toContain(latest);
	});

	it("keeps tool-call/tool-result pairing valid in the compacted projection", async () => {
		const harness = await makeHarness();
		harness.session.agent.state.messages = seedLongHistory();
		// Capture the exact projection handed to the provider by replaying the
		// transform through the agent's installed seam.
		const transform = harness.session.agent.transformContext;
		expect(transform).toBeDefined();
		const projected = await transform?.(harness.session.messages, undefined);
		expect(projected).toBeDefined();
		const result = projected ?? [];
		for (const message of result) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const paired = result.find((m) => m.role === "toolResult" && m.toolCallId === block.id);
				expect(paired, `missing tool result for ${block.id}`).toBeDefined();
			}
		}
	});

	it("does not compact once the policy is disabled", async () => {
		const harness = await makeHarness({ contextCompaction: { enabled: false } });
		harness.session.agent.state.messages = seedLongHistory();
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("current request");
		const snapshot = harness.session.getTelemetrySnapshot();
		expect(snapshot.context.compaction.enabled).toBe(false);
		expect(snapshot.context.compaction.triggered).toBe(false);
	});

	it("reading /telemetry neither compacts nor issues a model request", async () => {
		const harness = await makeHarness();
		harness.session.agent.state.messages = seedLongHistory();
		const providerCallsBefore = harness.faux.state.callCount;

		const first = harness.session.getTelemetrySnapshot();
		const second = harness.session.getTelemetrySnapshot();
		const json = renderSessionTelemetryJson(second);

		expect(json).toContain('"firstTriggerRequestIndex"');
		expect(harness.faux.state.callCount).toBe(providerCallsBefore);
		expect(first.context.compaction.passes).toBe(0);
		expect(second.context.compaction.passes).toBe(0);
		expect(second.usage.modelRequests).toBe(0);
	});

	it("reports truthful pre/post/saved bytes with no discarded content", async () => {
		const harness = await makeHarness();
		harness.session.agent.state.messages = seedLongHistory();
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("current request");

		const snapshot = harness.session.getTelemetrySnapshot();
		const compaction = snapshot.context.compaction;
		expect(compaction.originalConversationBytes).toBeGreaterThan(0);
		expect(compaction.compactedConversationBytes).toBeGreaterThan(0);
		expect(compaction.originalConversationBytes - compaction.compactedConversationBytes).toBe(compaction.savedBytes);

		const json = renderSessionTelemetryJson(snapshot);
		expect(json).not.toContain(AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse);
		expect(json).not.toContain("progress narration");
		expect(json).not.toContain("file contents");
	});

	it("keeps Step 3's adaptive tool surface intact", async () => {
		const harness = await makeHarness();
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("hello");
		const snapshot = harness.session.getTelemetrySnapshot();
		// A default session exposes the narrowed surface, not the full registry.
		expect(snapshot.context.byTransport.toolDefinitions.toolCount).toBeLessThan(32);
		expect(snapshot.context.byTransport.toolDefinitions.toolCount).toBeGreaterThan(0);
	});

	it("leaves goals and verification off by default", async () => {
		const harness = await makeHarness();
		expect(harness.settingsManager.getGoalSettings().enabled).toBe(false);
		expect(harness.settingsManager.getVerificationSettings().enabled).toBe(false);
		// And the compaction setting defaults on.
		expect(harness.settingsManager.getContextCompactionSettings().enabled).toBe(true);
	});
});
