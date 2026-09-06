import { describe, expect, it } from "vitest";
import { InMemorySessionRepo, InMemorySessionStorage, Session } from "../../../src/harness/session/index.ts";
import type { AgentMessage } from "../../../src/types.ts";

const message = (text: string): AgentMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: 1,
});

describe("explicit session and branch ownership", () => {
	it("keeps global facts on Session and branch state on explicit Branch objects", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "ownership" });
		await session.setName("global");
		const root = await session.appendMessage(message("root"));
		await session.setLabel(root, "label");
		const left = await session.acquireBranch("left", root);
		const right = await session.acquireBranch("right", root);
		const leftEntry = await left.appendMessage(message("left"));
		const rightEntry = await right.appendMessage(message("right"));

		expect(await session.getName()).toBe("global");
		expect(await session.getLabel(root)).toBe("label");
		expect(await left.getTipId()).toBe(leftEntry);
		expect(await right.getTipId()).toBe(rightEntry);
		expect((await left.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([root, leftEntry]);
		expect((await right.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([root, rightEntry]);
		expect(await session.branch("missing")).toBeUndefined();

		const reopened = await repo.open(await session.getMetadata());
		expect(await reopened.getName()).toBe("global");
		expect(await reopened.getLabel(root)).toBe("label");
		expect(await (await reopened.branch("left"))?.getTipId()).toBe(leftEntry);
	});

	it("acquires the same named branch idempotently under concurrent callers", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "concurrent", createdAt: 1 }));
		const root = await session.appendMessage(message("root"));
		const branches = await Promise.all(Array.from({ length: 32 }, () => session.acquireBranch("worker", root)));

		expect(new Set(branches.map((branch) => branch.name)).size).toBe(1);
		expect((await session.getLanes()).filter((lane) => lane.lane === "worker")).toHaveLength(1);
		expect(await Promise.all(branches.map((branch) => branch.getTipId()))).toEqual(Array(32).fill(root));
	});
});
