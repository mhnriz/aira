import { cleanupSessionResources } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { onAiraSessionCreated, onAiraSessionDisposed } from "../../src/aira/lifecycle.ts";
import { getAiraSessionState } from "../../src/aira/state.ts";
import { createTestSession, type TestSessionContext } from "../utilities.ts";

/**
 * Lifecycle bridge tests.
 *
 * The bridge contract: `onAiraSessionCreated` is invoked by the AgentSession
 * constructor (every session creation path), and release is wired through
 * pi-ai's session resource cleanup, which AgentSession.dispose() invokes for
 * every session teardown or replacement.
 */
describe("Aira lifecycle bridge", () => {
	it("creates canonical state for a session", () => {
		const state = onAiraSessionCreated("bridge-1", "new");
		expect(state.sessionId).toBe("bridge-1");
		expect(state.runtime).toBe("active");
		expect(state.startReason).toBe("new");
	});

	it("releases state on host cleanup", () => {
		onAiraSessionCreated("bridge-2", "fork");
		expect(getAiraSessionState("bridge-2")?.runtime).toBe("active");

		// Same registry path AgentSession.dispose() uses.
		cleanupSessionResources("bridge-2");

		expect(getAiraSessionState("bridge-2")?.runtime).toBe("disposed");
	});

	it("host cleanup without a session id is a no-op", () => {
		onAiraSessionCreated("bridge-3", "startup");
		expect(() => cleanupSessionResources()).not.toThrow();
		expect(getAiraSessionState("bridge-3")?.runtime).toBe("active");
	});

	it("host cleanup for unknown sessions is a no-op", () => {
		expect(() => cleanupSessionResources("bridge-unknown")).not.toThrow();
		expect(getAiraSessionState("bridge-unknown")).toBeUndefined();
	});

	it("keeps sessions isolated through the bridge", () => {
		onAiraSessionCreated("bridge-4a", "startup");
		onAiraSessionCreated("bridge-4b", "new");

		cleanupSessionResources("bridge-4a");

		expect(getAiraSessionState("bridge-4a")?.runtime).toBe("disposed");
		expect(getAiraSessionState("bridge-4b")?.runtime).toBe("active");
	});

	it("explicit disposal transitions state", () => {
		onAiraSessionCreated("bridge-5", "resume");
		onAiraSessionDisposed("bridge-5");
		expect(getAiraSessionState("bridge-5")?.runtime).toBe("disposed");
	});
});

/**
 * End-to-end seam tests with a real AgentSession: constructing a session must
 * acquire canonical state, disposing it must release it — no state may leak
 * between sessions.
 */
describe("Aira lifecycle seam with AgentSession", () => {
	it("acquires canonical state when a session is created and releases it on dispose", async () => {
		const { session, cleanup } = await createTestSession({ inMemory: true });
		try {
			const state = getAiraSessionState(session.sessionId);
			expect(state).toBeDefined();
			expect(state!.mode).toBe("build");
			expect(state!.runtime).toBe("active");
			expect(state!.project).toBe("unresolved");
			expect(state!.capabilities).toEqual(["core"]);
			expect(state!.startReason).toBe("startup");

			session.dispose();

			expect(getAiraSessionState(session.sessionId)?.runtime).toBe("disposed");
		} finally {
			cleanup();
		}
	});

	it("keeps state isolated between sessions through the seam", async () => {
		let first: TestSessionContext | undefined;
		let second: TestSessionContext | undefined;
		try {
			first = await createTestSession({ inMemory: true });
			second = await createTestSession({ inMemory: true });

			expect(first.session.sessionId).not.toBe(second.session.sessionId);

			first.session.dispose();

			expect(getAiraSessionState(first.session.sessionId)?.runtime).toBe("disposed");
			expect(getAiraSessionState(second.session.sessionId)?.runtime).toBe("active");
		} finally {
			first?.cleanup();
			second?.cleanup();
		}
	});
});
