/**
 * Aira live-code test fixture — a tiny LSP server spoken over stdio.
 *
 * Behavior:
 * - responds to initialize with utf-16 positions and full-document sync;
 * - on didOpen/didChange, publishes an error diagnostic for any document
 *   whose content contains `ERROR_MARKER`, otherwise publishes an empty
 *   set after a short delay;
 * - answers textDocument/definition, textDocument/references, and
 *   textDocument/documentSymbol with deterministic canned results;
 * - honors shutdown/exit.
 *
 * Modes (argv):
 *   --crash-on-initialize  exit(3) before the handshake completes
 *   --crash-after-open     exit(4) when a document opens
 */
let buffer = Buffer.alloc(0);

const CANNED_DEFINITION = {
	uri: "file:///canned/definition.ts",
	range: { start: { line: 10, character: 4 }, end: { line: 10, character: 12 } },
};

const CANNED_SYMBOLS = [
	{
		name: "stabilizeTray",
		kind: 12,
		range: { start: { line: 3, character: 0 }, end: { line: 6, character: 1 } },
		selectionRange: { start: { line: 3, character: 8 }, end: { line: 3, character: 22 } },
	},
	{
		name: "detectionState",
		kind: 12,
		range: { start: { line: 8, character: 0 }, end: { line: 10, character: 1 } },
		selectionRange: { start: { line: 8, character: 8 }, end: { line: 8, character: 22 } },
	},
];

function send(payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}

function sendResult(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function publishDiagnostics(uri, version, diagnostics) {
	send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics } });
}

function handleRequest(id, method, _params) {
	if (method === "initialize") {
		setTimeout(() => {
			sendResult(id, {
				capabilities: {
					positionEncoding: "utf-16",
					textDocumentSync: 1,
					definitionProvider: true,
					referencesProvider: true,
					documentSymbolProvider: true,
				},
				serverInfo: { name: "mock-lsp", version: "1" },
			});
		}, 20);
		return;
	}
	if (method === "textDocument/definition") {
		const respond = () => sendResult(id, CANNED_DEFINITION);
		if (delayNavigation) setTimeout(respond, 500);
		else respond();
		return;
	}
	if (method === "textDocument/references") {
		const references = manyReferences ? [CANNED_DEFINITION, CANNED_DEFINITION, CANNED_DEFINITION] : [CANNED_DEFINITION];
		const respond = () => sendResult(id, references);
		if (delayNavigation) setTimeout(respond, 500);
		else respond();
		return;
	}
	if (method === "textDocument/documentSymbol") {
		sendResult(id, CANNED_SYMBOLS);
		return;
	}
	if (method === "shutdown") {
		sendResult(id, null);
		return;
	}
	sendResult(id, null);
}

function handleNotification(method, params) {
	if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
		const doc = params.textDocument;
		const text = (params.contentChanges?.[0]?.text ?? doc.text) ?? "";
		const diagnostics = [];
		if (text.includes("ERROR_MARKER")) {
			diagnostics.push({
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
				severity: 1,
				code: "mock-err",
				source: "mock-lsp",
				message: "mock error: ERROR_MARKER present",
			});
		}
		setTimeout(() => publishDiagnostics(doc.uri, doc.version, diagnostics), 40);
	}
}

const crashOnInitialize = process.argv.includes("--crash-on-initialize");
const crashAfterOpen = process.argv.includes("--crash-after-open");
const manyReferences = process.argv.includes("--many-references");
const delayNavigation = process.argv.includes("--delay-navigation");
// Never respond to initialize (the client's handshake request times out).
const ignoreInitialize = process.argv.includes("--ignore-initialize");
// Write this process's pid to a file so tests can assert the child was killed.
const pidFileIndex = process.argv.indexOf("--pid-file");
const pidFile = pidFileIndex >= 0 ? process.argv[pidFileIndex + 1] : undefined;
if (pidFile) {
	import("node:fs").then((fs) => fs.writeFileSync(pidFile, String(process.pid)));
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const header = buffer.subarray(0, headerEnd).toString("ascii");
		const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
		if (!lengthMatch) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		const bodyLength = Number.parseInt(lengthMatch[1], 10);
		if (buffer.length < headerEnd + 4 + bodyLength) return;
		const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + bodyLength);
		buffer = buffer.subarray(headerEnd + 4 + bodyLength);
		const message = JSON.parse(body.toString("utf8"));
		if (crashOnInitialize && typeof message.id === "number") {
			process.exit(3);
		}
		if (ignoreInitialize && message.method === "initialize") {
			continue;
		}
		if (typeof message.id === "number") {
			handleRequest(message.id, message.method, message.params);
		} else if (message.method) {
			if (crashAfterOpen && message.method === "textDocument/didOpen") {
				process.exit(4);
			}
			handleNotification(message.method, message.params);
			if (message.method === "exit") {
				process.exit(0);
			}
		}
	}
});
