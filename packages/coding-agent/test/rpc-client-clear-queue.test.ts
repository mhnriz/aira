import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

describe("RpcClient clearQueue", () => {
	it("sends the clear_queue RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as {
			send: (command: { type: string }) => Promise<unknown>;
			getData: <T>(response: unknown) => T;
		};
		const send = vi.fn(async () => ({
			type: "response",
			command: "clear_queue",
			success: true,
			data: { steering: ["Change direction"], followUp: ["Summarize when finished"] },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;
		const result = await client.clearQueue();
		expect(send).toHaveBeenCalledWith({ type: "clear_queue" });
		expect(result).toEqual({ steering: ["Change direction"], followUp: ["Summarize when finished"] });
	});
});
