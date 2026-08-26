/**
 * Aira intelligence — minimal LSP client (JSON-RPC 2.0 over stdio).
 *
 * The smallest robust foundation for live-code intelligence. Supports the
 * operations Phase 5 needs: initialize/handshake, didOpen/didChange/didClose
 * document sync, publishDiagnostics ingestion, definition/references/
 * documentSymbol requests, position-encoding conversion, and graceful
 * shutdown. Everything else (semantic tokens, code actions, rename, …) is a
 * later phase.
 *
 * Failure discipline: every request is bounded by a timeout; connection
 * errors route into a crash callback; a dead server never throws into the
 * coordinator — callers get `undefined`/`[]` and the health surface records
 * the degradation.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { LaunchSpec } from "./registry.ts";

export type LspClientStatus = "new" | "starting" | "running" | "crashed" | "closed";

export interface LspClientCallbacks {
	onDiagnostics(params: { uri: string; version?: number; diagnostics: LspDiagnostic[] }): void;
	onLog(message: string): void;
	onStatusChange(status: LspClientStatus, error?: string): void;
}

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

export interface LspSymbol {
	name: string;
	kind: number;
	range: LspRange;
	selectionRange: LspRange;
}

/** LSP severity levels (DiagnosticSeverity). */
const LSP_SEVERITY_ERROR = 1;
const LSP_SEVERITY_WARNING = 2;

const REQUEST_TIMEOUT_MS = 10_000;

export class LspClient {
	status: LspClientStatus = "new";
	private child: ChildProcess | undefined;
	private buffer = Buffer.alloc(0);
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
	>();
	private nextId = 1;
	private documentVersions = new Map<string, number>();
	private positionEncoding: "utf-16" | "utf-8" = "utf-16";
	private rootUri: string;
	private readonly spec: LaunchSpec;
	private readonly projectRoot: string;
	private readonly callbacks: LspClientCallbacks;

	constructor(spec: LaunchSpec, projectRoot: string, callbacks: LspClientCallbacks) {
		this.spec = spec;
		this.projectRoot = projectRoot;
		this.callbacks = callbacks;
		this.rootUri = pathToFileURL(projectRoot).href;
	}

	get serverId(): string {
		return this.spec.command;
	}

	get isPositionUtf8(): boolean {
		return this.positionEncoding === "utf-8";
	}

	/** Spawn and handshake. Resolves when initialized (or rejects on failure). */
	async start(): Promise<void> {
		if (this.status === "running" || this.status === "starting") {
			return;
		}
		this.status = "starting";
		this.callbacks.onStatusChange(this.status);

		try {
			this.child = spawn(this.spec.argv0, this.spec.args, {
				cwd: this.projectRoot,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			this.markCrashed(error instanceof Error ? error.message : String(error));
			throw error;
		}

		const child = this.child;
		child.stdout?.on("data", (chunk: Buffer) => this.ingest(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = String(chunk).trim();
			if (text) {
				this.callbacks.onLog(`[${this.spec.command} stderr] ${text.slice(0, 500)}`);
			}
		});
		child.on("error", (error) => {
			this.markCrashed(error.message);
		});
		child.on("exit", (code, signal) => {
			if (this.status !== "closed") {
				this.markCrashed(`exited code=${code} signal=${signal ?? ""}`);
			}
		});

		const initResult = (await this.request("initialize", {
			processId: process.pid,
			clientInfo: { name: "aira" },
			rootUri: this.rootUri,
			workspaceFolders: [{ uri: this.rootUri, name: this.projectRoot }],
			capabilities: {
				textDocument: {
					definition: { dynamicRegistration: false },
					references: { dynamicRegistration: false },
					documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
					synchronization: { didSave: false },
				},
				// NOTE: do NOT advertise `workspace.workspaceFolders: true` here.
				// Empirically, pyright (vscode-languageserver) suppresses
				// textDocument/publishDiagnostics when the client declares the
				// workspaceFolders capability (Phase 5 verification finding);
				// the `workspaceFolders` array in the initialize params is
				// sufficient and harmless.
			},
		})) as
			| {
					capabilities?: { positionEncoding?: string; textDocumentSync?: unknown };
			  }
			| undefined;

		if (initResult?.capabilities?.positionEncoding === "utf-8") {
			this.positionEncoding = "utf-8";
		}

		this.notify("initialized", {});
		this.status = "running";
		this.callbacks.onStatusChange(this.status);
	}

	/** Send a request and await the response (bounded by a timeout). */
	request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request timed out: ${method}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.write(payload);
		});
	}

	/** Fire-and-forget notification. */
	notify(method: string, params: unknown): void {
		this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
	}

	/** Open a document (full content) and bump its version. */
	async didOpen(path: string, languageId: string, text: string): Promise<void> {
		const version = (this.documentVersions.get(path) ?? 0) + 1;
		this.documentVersions.set(path, version);
		this.notify("textDocument/didOpen", {
			textDocument: { uri: this.fileUri(path), languageId, version, text },
		});
	}

	/** Full-document sync for an already-open document. */
	async didChange(path: string, text: string): Promise<void> {
		const version = (this.documentVersions.get(path) ?? 0) + 1;
		this.documentVersions.set(path, version);
		this.notify("textDocument/didChange", {
			textDocument: { uri: this.fileUri(path), version },
			contentChanges: [{ text }],
		});
	}

	/** Close a document. */
	async didClose(path: string): Promise<void> {
		this.documentVersions.delete(path);
		this.notify("textDocument/didClose", { textDocument: { uri: this.fileUri(path) } });
	}

	/** Find definitions at a position. */
	async definitions(path: string, line: number, character: number): Promise<LspLocation[]> {
		const result = (await this.request("textDocument/definition", {
			textDocument: { uri: this.fileUri(path) },
			position: { line, character },
		})) as LspLocation | LspLocation[] | undefined;
		return normalizeLocations(result);
	}

	/** Find references at a position (optionally including the declaration). */
	async references(path: string, line: number, character: number, includeDeclaration = false): Promise<LspLocation[]> {
		const result = (await this.request("textDocument/references", {
			textDocument: { uri: this.fileUri(path) },
			position: { line, character },
			context: { includeDeclaration },
		})) as LspLocation[] | undefined;
		return Array.isArray(result) ? result : [];
	}

	/** Document symbols (hierarchical when supported; flattened here). */
	async documentSymbols(path: string): Promise<LspSymbol[]> {
		const result = (await this.request("textDocument/documentSymbol", {
			textDocument: { uri: this.fileUri(path) },
		})) as LspSymbol[] | undefined;
		if (!Array.isArray(result)) {
			return [];
		}
		return result;
	}

	/** Graceful shutdown: shutdown request, exit notification, then kill. */
	async shutdown(): Promise<void> {
		if (this.status === "closed" || this.status === "new") {
			return;
		}
		const child = this.child;
		this.status = "closed";
		this.callbacks.onStatusChange(this.status);
		if (!child || child.exitCode !== null) {
			return;
		}
		try {
			this.request("shutdown", null).catch(() => undefined);
		} catch {
			// Ignore: shutdown is best-effort.
		}
		this.notify("exit", null);
		const killTimer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}, 1500);
		killTimer.unref();
	}

	private write(payload: string): void {
		const child = this.child;
		if (!child || !child.stdin?.writable || this.status === "closed") {
			return;
		}
		const body = Buffer.from(payload, "utf8");
		const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
		child.stdin.write(Buffer.concat([header, body]));
	}

	private ingest(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
			if (!lengthMatch) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const bodyLength = Number.parseInt(lengthMatch[1] ?? "0", 10);
			if (this.buffer.length < headerEnd + 4 + bodyLength) {
				return;
			}
			const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + bodyLength);
			this.buffer = this.buffer.subarray(headerEnd + 4 + bodyLength);
			try {
				this.dispatch(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
			} catch {
				// Malformed server payload: ignore the frame, keep the connection.
			}
		}
	}

	private dispatch(message: Record<string, unknown>): void {
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) {
				return;
			}
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(new Error(JSON.stringify(message.error)));
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (typeof message.id === "string") {
			// Unknown pending id: ignore.
			return;
		}
		const method = message.method;
		if (method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri: string; version?: number; diagnostics: LspDiagnostic[] };
			this.callbacks.onDiagnostics({
				uri: params.uri,
				version: params.version,
				diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
			});
		} else if (method === "window/logMessage" || method === "window/showMessage") {
			const params = message.params as { type?: number; message?: string };
			if (typeof params.message === "string") {
				this.callbacks.onLog(params.message.slice(0, 500));
			}
		}
	}

	private markCrashed(error: string): void {
		if (this.status === "closed") {
			return;
		}
		this.status = "crashed";
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`LSP server crashed: ${error}`));
		}
		this.pending.clear();
		this.callbacks.onStatusChange(this.status, error);
	}

	private fileUri(path: string): string {
		return pathToFileURL(path).href;
	}
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

function normalizeLocations(result: LspLocation | LspLocation[] | undefined): LspLocation[] {
	if (!result) {
		return [];
	}
	return Array.isArray(result) ? result : [result];
}

/** Convert a utf-16 character offset to the server's position encoding. */
export function convertCharacterOffset(encoding: "utf-16" | "utf-8", lineText: string, character: number): number {
	if (encoding === "utf-16" || character <= 0) {
		return character;
	}
	// Walk code points so a boundary inside a surrogate pair counts the whole
	// code point's utf-8 bytes (slice-based prefixes split the pair and Node
	// would emit replacement bytes, undercounting the offset).
	let byteLength = 0;
	let seenUnits = 0;
	for (const codePoint of lineText) {
		if (seenUnits >= character) {
			break;
		}
		byteLength += Buffer.byteLength(codePoint, "utf8");
		seenUnits += codePoint.length;
	}
	return byteLength;
}

export { LSP_SEVERITY_ERROR, LSP_SEVERITY_WARNING };
