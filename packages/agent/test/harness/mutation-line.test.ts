import { describe, expect, it } from "vitest";
import { MutationLine } from "../../src/harness/session/mutation-line.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("MutationLine", () => {
	it("serializes concurrent durable mutations in submission order", async () => {
		const line = new MutationLine();
		const gate = deferred();
		const order: string[] = [];
		const first = line.run(async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
			return "first";
		});
		const second = line.run(() => {
			order.push("second");
			return "second";
		});

		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		gate.resolve();
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("rejects nested mutations without deadlocking", async () => {
		const line = new MutationLine();
		await expect(
			line.run((scope) => {
				scope.mutate(() => "nested");
			}),
		).rejects.toThrow("Nested durable session mutations are not allowed");
		await expect(line.run(() => "after failure")).resolves.toBe("after failure");
	});

	it("does not publish a partial projection when a mutation fails", async () => {
		const line = new MutationLine();
		let committed: string[] = [];
		await expect(
			line.run(() => {
				const staged = [...committed, "partial"];
				void staged;
				throw new Error("storage failure");
			}),
		).rejects.toThrow("storage failure");
		expect(committed).toEqual([]);
		await line.run(() => {
			committed = [...committed, "valid"];
		});
		expect(committed).toEqual(["valid"]);
	});

	it("recovers after a failed mutation", async () => {
		const line = new MutationLine();
		await expect(line.run(() => Promise.reject(new Error("failed commit")))).rejects.toThrow("failed commit");
		await expect(line.run(() => 42)).resolves.toBe(42);
	});

	it("keeps ordinary readers on committed state while a mutation is pending", async () => {
		const line = new MutationLine();
		const gate = deferred();
		let committed = ["before"];
		const mutation = line.run(async () => {
			const next = [...committed, "after"];
			await gate.promise;
			committed = next;
		});
		await Promise.resolve();
		expect(committed).toEqual(["before"]);
		gate.resolve();
		await mutation;
		expect(committed).toEqual(["before", "after"]);
	});

	it("rejects representative external effects from mutation callbacks", async () => {
		const effects = ["provider", "tool", "shell", "timer", "network", "event"];
		for (const effect of effects) {
			const line = new MutationLine();
			await expect(line.run((scope) => scope.externalEffect(effect))).rejects.toThrow(
				`External effect "${effect}" is not allowed inside a durable session mutation`,
			);
		}
	});

	it("maintains ordering under repeated concurrent writes", async () => {
		const line = new MutationLine();
		const committed: number[] = [];
		const writes = Array.from({ length: 200 }, (_, index) => line.run(() => committed.push(index)));
		await Promise.all(writes);
		expect(committed).toEqual(Array.from({ length: 200 }, (_, index) => index));
	});

	it("seals queued and future mutations after the running mutation drains", async () => {
		const line = new MutationLine();
		const gate = deferred();
		const running = line.run(async () => {
			await gate.promise;
			return "running";
		});
		await Promise.resolve();
		const queued = line.run(() => "queued");
		const closed = new Error("closed");

		const drained = line.seal(closed);
		await expect(line.run(() => "late")).rejects.toBe(closed);
		gate.resolve();
		await expect(running).resolves.toBe("running");
		await expect(queued).rejects.toBe(closed);
		await drained;
	});
});
