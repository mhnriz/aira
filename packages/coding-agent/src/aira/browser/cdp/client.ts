/**
 * Aira browser — minimal CDP client over the native WebSocket.
 *
 * Zero-dependency CDP transport (Node >= 22 ships a stable global WebSocket).
 * One connection per browser: browser-level commands (Target.*) go over the
 * connection, page-level commands are addressed per-session (flattened
 * attach). Events are dispatched to per-tab buffers by the session layer;
 * this module only correlates request ids, applies timeouts, and surfaces
 * truthful errors (`connection closed`, `timeout`, `error: <code>`).
 */
import type { AiraBrowserOperationResult } from "../types.ts";

export interface CdpEvent {
	method: string;
	params: Record<string, unknown>;
	/** Present for events from an attached target (flattened mode). */
	sessionId?: string;
}

export interface CdpConnectionOptions {
	url: string;
	onEvent: (event: CdpEvent) => void;
	onClose: (reason: string) => void;
	/** Timeout for a single command (default 15s). */
	commandTimeoutMs?: number;
}

export interface CdpResult<T = unknown> {
	ok: boolean;
	data?: T;
	error?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export class CdpClient {
	private readonly url: string;
	private readonly onEvent: (event: CdpEvent) => void;
	private readonly onClose: (reason: string) => void;
	private readonly commandTimeoutMs: number;
	private ws: WebSocket | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (r: CdpResult) => void; timer: NodeJS.Timeout }>();
	private closedReason: string | undefined;

	constructor(options: CdpConnectionOptions) {
		this.url = options.url;
		this.onEvent = options.onEvent;
		this.onClose = options.onClose;
		this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.ws) {
				resolve();
				return;
			}
			let ws: WebSocket;
			try {
				ws = new WebSocket(this.url);
			} catch (err) {
				reject(err);
				return;
			}
			this.ws = ws;
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
			ws.addEventListener("message", (event) => {
				this.onMessage(event.data);
			});
			ws.addEventListener("close", () => {
				const reason = this.closedReason ?? "browser connection closed";
				this.settleAll(reason);
				this.onClose(reason);
			});
			// Attach the error listener permanently AFTER the once() probe so a
			// mid-session socket error still settles pending commands instead of
			// becoming an unhandled event.
			ws.addEventListener("error", () => {
				this.closedReason = "CDP socket error";
			});
		});
	}

	send<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		options?: { timeoutMs?: number },
	): Promise<CdpResult<T>> {
		const connection = this.ws;
		if (!connection || connection.readyState !== WebSocket.OPEN) {
			return Promise.resolve({ ok: false, error: "browser connection is not open" });
		}
		const id = this.nextId++;
		const payload = { id, method, params };
		if (sessionId) {
			(payload as Record<string, unknown>).sessionId = sessionId;
		}
		const timeoutMs = options?.timeoutMs ?? this.commandTimeoutMs;
		return new Promise<CdpResult<T>>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ ok: false, error: `CDP command timed out after ${timeoutMs}ms (${method})` });
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (r: CdpResult) => void, timer });
			try {
				connection.send(JSON.stringify(payload));
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ ok: false, error: `CDP send failed: ${String(err)}` });
			}
		});
	}

	close(): void {
		this.closedReason = "closed by Aira";
		const connection = this.ws;
		this.ws = undefined;
		if (connection && connection.readyState === WebSocket.OPEN) {
			try {
				connection.close(1000, "browser closed");
			} catch {
				// already closing
			}
		}
		this.settleAll(this.closedReason);
	}

	private onMessage(data: unknown): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(String(data)) as Record<string, unknown>;
		} catch {
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) {
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(message.id);
			if (message.error) {
				const error = message.error as { message?: string; code?: number };
				pending.resolve({ ok: false, error: `CDP error: ${error.message ?? "unknown"}` });
			} else {
				pending.resolve({ ok: true, data: message.result as unknown });
			}
			return;
		}
		const method = message.method;
		if (typeof method === "string") {
			this.onEvent({
				method,
				params: (message.params as Record<string, unknown>) ?? {},
				sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
			});
		}
	}

	private settleAll(reason: string): void {
		for (const { resolve, timer } of this.pending.values()) {
			clearTimeout(timer);
			resolve({ ok: false, error: reason });
		}
		this.pending.clear();
	}
}

/** Operation-result helper for provider code. */
export function failResult(
	operation: string,
	reason: string,
	extra?: Partial<AiraBrowserOperationResult>,
): AiraBrowserOperationResult {
	return { ok: false, operation, reason, ...extra };
}

export function okResult(operation: string, extra?: Partial<AiraBrowserOperationResult>): AiraBrowserOperationResult {
	return { ok: true, operation, ...extra };
}
