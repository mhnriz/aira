import { describe, expect, it } from "vitest";
import { onAiraSessionCreated, onAiraSessionDisposed } from "../../src/aira/lifecycle.ts";
import { getAiraSessionState } from "../../src/aira/state.ts";
import { createTestSession, type TestSessionContext } from "../utilities.ts";

/**
 * Lifecycle bridge tests.
 *
 * The bridge contract: `onAiraSessionCreated` is invoked by the AgentSession
 * constructor (every session creation path) and returns the ownership handle;
 * `onAiraSessionDisposed` is invoked by `AgentSession.dispose()` with that
 * handle for every session teardown or replacement.
 */
describe("Aira lifecycle bridge", () => {
	it("creates canonical state for a session", () => {
		const state = onAiraSessionCreated("bridge-1", "new");
		expect(state.sessionId).toBe("bridge-1");
		expect(state.runtime).toBe("active");
		expect(state.startReason).toBe("new");
	});

	it("releases state on host disposal by its owner", () => {
		const state = onAiraSessionCreated("bridge-2", "fork");
		expect(getAiraSessionState("bridge-2")?.runtime).toBe("active");

		onAiraSessionDisposed("bridge-2", state);

		expect(getAiraSessionState("bridge-2")?.runtime).toBe("disposed");
	});

	it("ignores disposal by a stale owner", () => {
		const first = onAiraSessionCreated("bridge-3", "startup");
		const second = onAiraSessionCreated("bridge-3", "resume");

		// First owner disposes after being replaced: must not kill the new state.
		onAiraSessionDisposed("bridge-3", first);
		expect(getAiraSessionState("bridge-3")).toBe(second);
		expect(getAiraSessionState("bridge-3")?.runtime).toBe("active");

		onAiraSessionDisposed("bridge-3", second);
		expect(getAiraSessionState("bridge-3")?.runtime).toBe("disposed");
	});

	it("ignores disposal of unknown sessions", () => {
		const state = onAiraSessionCreated("bridge-4", "startup");
		expect(() => onAiraSessionDisposed("bridge-unknown", state)).not.toThrow();
		expect(getAiraSessionState("bridge-unknown")).toBeUndefined();
	});

	it("keeps sessions isolated through the bridge", () => {
		const a = onAiraSessionCreated("bridge-5a", "startup");
		onAiraSessionCreated("bridge-5b", "new");

		onAiraSessionDisposed("bridge-5a", a);

		expect(getAiraSessionState("bridge-5a")?.runtime).toBe("disposed");
		expect(getAiraSessionState("bridge-5b")?.runtime).toBe("active");
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
			expect(state!.project).toBeDefined();
			expect(state!.project?.root).toBeUndefined();
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
