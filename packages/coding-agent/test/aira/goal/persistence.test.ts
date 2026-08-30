/**
 * Phase 10 — goal persistence: bounded machine-readable state per session,
 * ownership (new/fork sessions never inherit), running-class goals recover
 * as paused, clear removes state, failures degrade gracefully.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AiraGoalPersistableState, createAiraGoalPersistence } from "../../../src/aira/goal/persistence.ts";

function makeBaseDir(): { base: string; cleanup: () => void } {
	const base = join(tmpdir(), `aira-goal-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(base, { recursive: true });
	return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function sampleState(overrides: Partial<AiraGoalPersistableState> = {}): AiraGoalPersistableState {
	return {
		id: "g-1",
		objective: "implement authentication",
		status: "paused",
		round: 2,
		startedAt: 1_000,
		updatedAt: 2_000,
		completedAt: undefined,
		stopReason: "user",
		waiting: undefined,
		lastVerdict: "fail",
		sessionTokens: 42_000,
		...overrides,
	};
}

describe("Aira goal persistence (Phase 10)", () => {
	it("saves and loads bounded machine-readable state for the same session", () => {
		const { base, cleanup } = makeBaseDir();
		try {
			const store = createAiraGoalPersistence("session-1", "startup", { baseDir: base });
			const record = store.save(sampleState());
			expect(record.status).toBe("ok");
			expect(existsSync(record.path!)).toBe(true);
			const loaded = store.load();
			expect(loaded?.sessionId).toBe("session-1");
			expect(loaded?.goal.objective).toBe("implement authentication");
			expect(loaded?.goal.status).toBe("paused");
			expect(loaded?.goal.lastVerdict).toBe("fail");
			expect(loaded?.goal.sessionTokens).toBe(42_000);
			const raw = JSON.parse(readFileSync(record.path!, "utf-8"));
			expect(raw.version).toBe(1);
			// bounded: no transcripts, no task graphs
			expect(Object.keys(raw)).toEqual(["version", "sessionId", "goal"]);
		} finally {
			cleanup();
		}
	});

	it("recovery is restricted to startup/resume sessions of the SAME session id", () => {
		const { base, cleanup } = makeBaseDir();
		try {
			const store = createAiraGoalPersistence("session-1", "startup", { baseDir: base });
			store.save(sampleState());
			// same session, resume reason: recovered
			const resumed = createAiraGoalPersistence("session-1", "resume", { baseDir: base });
			expect(resumed.recover()?.status).toBe("paused");
			// unrelated sessions (new/fork have different ids) never inherit
			const other = createAiraGoalPersistence("session-2", "startup", { baseDir: base });
			expect(other.recover()).toBeUndefined();
			// a fresh runtime over a DIFFERENT session id cannot even load the file
			expect(other.load()).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("a running-class goal persisted at crash time recovers as paused (never auto-resumes)", () => {
		const { base, cleanup } = makeBaseDir();
		try {
			const store = createAiraGoalPersistence("session-1", "startup", { baseDir: base });
			store.save(sampleState({ status: "repairing", round: 3 }));
			const recovered = createAiraGoalPersistence("session-1", "startup", { baseDir: base }).recover();
			expect(recovered?.status).toBe("paused");
			expect(recovered?.stopReason).toBe("interrupted");
			expect(recovered?.round).toBe(3);
		} finally {
			cleanup();
		}
	});

	it("terminal states recover as-is; clear removes the file", () => {
		const { base, cleanup } = makeBaseDir();
		try {
			const store = createAiraGoalPersistence("session-1", "resume", { baseDir: base });
			store.save(sampleState({ status: "completed", completedAt: 9_000, stopReason: undefined }));
			const recovered = createAiraGoalPersistence("session-1", "resume", { baseDir: base }).recover();
			expect(recovered?.status).toBe("completed");
			expect(recovered?.completedAt).toBe(9_000);
			expect(store.clear().status).toBe("ok");
			expect(existsSync(store.path)).toBe(false);
			expect(createAiraGoalPersistence("session-1", "resume", { baseDir: base }).recover()).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("unknown/malformed files never break recovery (graceful degradation)", () => {
		const { base, cleanup } = makeBaseDir();
		try {
			const store = createAiraGoalPersistence("session-1", "startup", { baseDir: base });
			// wrong session id inside the file
			store.save(sampleState());
			const raw = JSON.parse(readFileSync(store.path, "utf-8"));
			raw.sessionId = "session-other";
			writeFileSync(store.path, JSON.stringify(raw));
			expect(store.load()).toBeUndefined();
			expect(createAiraGoalPersistence("session-1", "startup", { baseDir: base }).recover()).toBeUndefined();
			// corrupt json
			writeFileSync(store.path, "{ not json");
			expect(store.load()).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});
