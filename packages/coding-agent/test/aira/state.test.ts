import { describe, expect, it } from "vitest";
import {
	acquireAiraSessionState,
	DEFAULT_AIRA_CAPABILITIES,
	DEFAULT_AIRA_MODE,
	DEFAULT_AIRA_PROJECT,
	disposeAiraSessionState,
	getActiveAiraSessionStates,
	getAiraSessionState,
} from "../../src/aira/state.ts";

describe("AiraSessionState", () => {
	it("initializes with Phase 1 default values", () => {
		const state = acquireAiraSessionState("session-1", "startup");

		expect(state.sessionId).toBe("session-1");
		expect(state.startReason).toBe("startup");
		expect(state.mode).toBe(DEFAULT_AIRA_MODE);
		expect(state.mode).toBe("build");
		expect(state.runtime).toBe("active");
		expect(state.project).toBe(DEFAULT_AIRA_PROJECT);
		expect(state.project).toBe("unresolved");
		expect(state.capabilities).toEqual(DEFAULT_AIRA_CAPABILITIES);
		expect(state.capabilities).toEqual(["core"]);
		expect(state.disposedAt).toBeUndefined();
		expect(state.createdAt).toBeGreaterThan(0);
	});

	it("defaults the start reason to startup", () => {
		const state = acquireAiraSessionState("session-2");
		expect(state.startReason).toBe("startup");
	});

	it("allows retrieving the canonical state", () => {
		acquireAiraSessionState("session-3", "new");
		const state = getAiraSessionState("session-3");
		expect(state?.sessionId).toBe("session-3");
		expect(state?.startReason).toBe("new");
	});

	it("returns undefined for unknown sessions", () => {
		expect(getAiraSessionState("does-not-exist")).toBeUndefined();
	});

	it("replaces the previous owner when re-acquired while active", () => {
		const first = acquireAiraSessionState("session-4", "startup");
		const second = acquireAiraSessionState("session-4", "fork");

		// Ownership transferred: the latest acquire owns the canonical entry.
		expect(second).not.toBe(first);
		expect(getAiraSessionState("session-4")).toBe(second);

		// The stale owner can no longer release the entry.
		expect(disposeAiraSessionState("session-4", first)).toBe(false);
		expect(getAiraSessionState("session-4")?.runtime).toBe("active");
		expect(disposeAiraSessionState("session-4", second)).toBe(true);
		expect(getAiraSessionState("session-4")?.runtime).toBe("disposed");
	});

	it("keeps sessions isolated from each other", () => {
		const a = acquireAiraSessionState("session-5a", "startup");
		const b = acquireAiraSessionState("session-5b", "new");

		expect(a).not.toBe(b);
		disposeAiraSessionState("session-5a", a);

		// Disposing A must not affect B.
		expect(getAiraSessionState("session-5b")?.runtime).toBe("active");
		expect(getAiraSessionState("session-5a")?.runtime).toBe("disposed");
		expect(getActiveAiraSessionStates().map((s) => s.sessionId)).toContain("session-5b");
		expect(getActiveAiraSessionStates().map((s) => s.sessionId)).not.toContain("session-5a");
	});

	it("marks state disposed and records the timestamp", () => {
		const before = Date.now();
		const state = acquireAiraSessionState("session-6", "resume");
		const released = disposeAiraSessionState("session-6", state);

		expect(released).toBe(true);
		const disposed = getAiraSessionState("session-6");
		expect(disposed?.runtime).toBe("disposed");
		expect(disposed?.disposedAt).toBeGreaterThanOrEqual(before);
	});

	it("dispose is idempotent and safe for unknown or stale owners", () => {
		const state = acquireAiraSessionState("session-7", "startup");
		expect(disposeAiraSessionState("session-7", state)).toBe(true);
		expect(disposeAiraSessionState("session-7", state)).toBe(false);
		expect(disposeAiraSessionState("never-acquired", acquireAiraSessionState("other-7", "startup"))).toBe(false);
	});

	it("allows re-acquisition after disposal", () => {
		const first = acquireAiraSessionState("session-8", "startup");
		disposeAiraSessionState("session-8", first);
		const revived = acquireAiraSessionState("session-8", "resume");
		expect(revived.runtime).toBe("active");
		expect(revived.startReason).toBe("resume");
		expect(revived).not.toBe(first);
	});

	it("tracks only active states", () => {
		const a = acquireAiraSessionState("session-9a", "startup");
		acquireAiraSessionState("session-9b", "startup");
		disposeAiraSessionState("session-9a", a);

		// The registry is a file-level singleton: assert relative behavior
		// rather than the absolute contents of the registry.
		const active = getActiveAiraSessionStates();
		expect(active.map((s) => s.sessionId)).toContain("session-9b");
		expect(active.map((s) => s.sessionId)).not.toContain("session-9a");
		expect(active.every((s) => s.runtime === "active")).toBe(true);
	});
});
