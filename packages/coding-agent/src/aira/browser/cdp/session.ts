/**
 * Aira browser — CDP tab sessions.
 *
 * One `CdpTabSession` per attached Chrome page: enables the domains the
 * provider needs, routes events into per-tab bounded buffers (console,
 * network, dialogs), and owns the ref → backend-node-id map with signatures
 * for staleness decisions. The provider (and therefore Aira) never sees raw
 * CDP session handles — everything crosses the provider boundary as data.
 */
import type { CdpClient, CdpEvent } from "./client.ts";
import {
	type AiraConsoleBuffer,
	type ConsoleEventParams,
	createAiraConsoleBuffer,
	type LogEntryParams,
} from "./console.ts";
import {
	type AiraNetworkBuffer,
	createAiraNetworkBuffer,
	type NetworkLoadingFailedParams,
	type NetworkRequestWillBeSentParams,
	type NetworkResponseReceivedParams,
} from "./network.ts";

export interface AiraTabDialog {
	type: "alert" | "confirm" | "prompt" | "beforeunload";
	message: string;
}

const ENABLED_DOMAINS = ["Page", "DOM", "Runtime", "Network", "Accessibility", "Log"] as const;

export class CdpTabSession {
	readonly targetId: string;
	readonly sessionId: string;
	readonly console: AiraConsoleBuffer;
	readonly network: AiraNetworkBuffer;

	dialog: AiraTabDialog | undefined;
	/** Ref → backend node id (assigned by observations). */
	private readonly refMap = new Map<string, number>();
	/** Ref → signature (role|name|value|state) at assignment time. */
	private readonly refSignatures = new Map<string, string>();
	/** Page URL at the last ref assignment (cross-navigation staleness). */
	refPageUrl: string | undefined;

	constructor(targetId: string, sessionId: string) {
		this.targetId = targetId;
		this.sessionId = sessionId;
		this.console = createAiraConsoleBuffer();
		this.network = createAiraNetworkBuffer();
	}

	/** Enable the domains for this tab (best-effort per domain). */
	async enable(client: CdpClient): Promise<void> {
		for (const domain of ENABLED_DOMAINS) {
			await client.send(`${domain}.enable`, {}, this.sessionId);
		}
	}

	handleEvent(event: CdpEvent): void {
		switch (event.method) {
			case "Page.frameNavigated": {
				// A main-frame navigation invalidates every ref: CDP backend
				// node ids are reused across documents, so refs must never
				// silently target a node in a different page. Subframe
				// navigations keep refs (they do not reset backend ids).
				const frame = (event.params as { frame?: { id?: string; parentId?: string } }).frame;
				if (frame?.id && !frame.parentId) {
					this.refMap.clear();
					this.refSignatures.clear();
				}
				break;
			}
			case "Page.javascriptDialogOpening": {
				const params = event.params as { type?: string; message?: string };
				this.dialog = {
					type: normalizeDialogType(params.type),
					message: params.message ?? "",
				};
				break;
			}
			case "Runtime.consoleAPICalled":
				this.console.ingestConsoleApi(event.params as ConsoleEventParams);
				break;
			case "Log.entryAdded":
				this.console.ingestLogEntry(event.params as LogEntryParams);
				break;
			case "Network.requestWillBeSent":
				this.network.ingestRequestWillBeSent(event.params as NetworkRequestWillBeSentParams);
				break;
			case "Network.responseReceived":
				this.network.ingestResponseReceived(event.params as NetworkResponseReceivedParams);
				break;
			case "Network.loadingFailed":
				this.network.ingestLoadingFailed(event.params as NetworkLoadingFailedParams);
				break;
			default:
				break;
		}
	}

	setRefs(refMap: Map<string, number>, signatures: Map<string, string>, pageUrl?: string): void {
		this.refMap.clear();
		this.refSignatures.clear();
		for (const [ref, backendId] of refMap) this.refMap.set(ref, backendId);
		for (const [ref, sig] of signatures) this.refSignatures.set(ref, sig);
		if (pageUrl !== undefined) this.refPageUrl = pageUrl;
	}

	resolveRef(ref: string): number | undefined {
		return this.refMap.get(ref);
	}

	/** All ref → backend-id pairs (diff/staleness internals). */
	allRefs(): ReadonlyArray<[string, number]> {
		return [...this.refMap.entries()];
	}

	signatureOf(ref: string): string | undefined {
		return this.refSignatures.get(ref);
	}

	takeDialog(): AiraTabDialog | undefined {
		const dialog = this.dialog;
		this.dialog = undefined;
		return dialog;
	}

	clear(): void {
		this.dialog = undefined;
		this.refMap.clear();
		this.refSignatures.clear();
		this.refPageUrl = undefined;
		this.console.clear();
		this.network.clear();
	}
}

function normalizeDialogType(type: string | undefined): AiraTabDialog["type"] {
	if (type === "confirm" || type === "prompt" || type === "beforeunload") return type;
	return "alert";
}
