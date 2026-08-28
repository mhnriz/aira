/**
 * Aira browser — runtime types.
 *
 * Internal records of the browser subsystem. Everything here is owned by the
 * browser manager and its provider; only bounded summaries travel into
 * canonical state (see status.ts). No Playwright/CDP objects cross this
 * boundary — the provider speaks in plain data.
 */

/** Aira-owned browser session (one per manager, launched by Aira). */
export interface AiraBrowserSessionRecord {
	id: string;
	ownerSessionId: string;
	providerId: string;
	/** Aira-owned isolated profile directory. */
	profileDir: string;
	/** OS pid of the launched browser process, when known. */
	pid?: number;
	status: "starting" | "running" | "degraded" | "closed";
	/** Bounded tab table. */
	tabs: AiraBrowserTabRecord[];
	createdAt: number;
	lastActivityAt: number;
	/** Truthful failure reason, when the session is degraded/closed. */
	reason?: string;
}

export interface AiraBrowserTabRecord {
	id: string;
	/** CDP target id (provider-internal identity, never exposed to the model). */
	targetId: string;
	url: string;
	title: string;
	readyState: "loading" | "interactive" | "complete" | "unknown";
	/** Observation revision for this tab (bumps on each semantic observation). */
	observationRevision: number;
	/** One-line observation summary, when observed. */
	observationSummary?: string;
	lastActivityAt: number;
}

/** A console log record (bounded per tab). */
export interface AiraBrowserConsoleRecord {
	seq: number;
	level: "error" | "warn" | "info" | "debug" | "log";
	text: string;
	source?: string;
	line?: number;
	firstAt: number;
	lastAt: number;
	count: number;
}

/** A network failure record (bounded per tab). */
export interface AiraBrowserNetworkRecord {
	/** Provider-side drain cursor. */
	seq: number;
	requestId: string;
	method: string;
	url: string;
	/** HTTP status when the request received a response. */
	status?: number;
	/** Failure reason from loadingFailed when the request never completed. */
	errorText?: string;
	resourceType: string;
	firstAt: number;
	lastAt: number;
	count: number;
}

/** A semantic observation of a page (bounded, provider-independent). */
export interface AiraBrowserObservation {
	/** Page title. */
	title: string;
	url: string;
	readyState: string;
	/** Compact one-line summary ("player page · ready · 3 inputs · 2 buttons"). */
	summary: string;
	/** Number of slim nodes in the full tree (before outline truncation). */
	nodeCount: number;
	/** Bounded outline text (roles/names/refs), truncated with marker. */
	outline: string;
	/** Color when the outlined tree was truncated by the budget. */
	truncated: boolean;
	/** Interactive targets with stable refs (the model interacts with these). */
	targets: AiraBrowserTarget[];
	/** When the observation was captured. */
	at: number;
}

/** A stable element handle from a semantic observation. */
export interface AiraBrowserTarget {
	ref: string;
	role: string;
	name?: string;
	value?: string;
	state?: string;
	/** Viewport center coordinates (CSS px), when resolvable. */
	x?: number;
	y?: number;
}

/** A page-state change describing a mutation (click/fill/...) aftermath. */
export interface AiraBrowserChange {
	kind: "changed" | "new" | "removed";
	ref: string;
	role: string;
	name: string;
	detail?: string;
}

/** Structured operation result for every browser operation. */
export interface AiraBrowserOperationResult {
	ok: boolean;
	/** Operation name ("navigate", "click", ...). */
	operation: string;
	/** Target description ("[e3] button Submit", "localhost:5173", ...). */
	target?: string;
	/** Truthful failure reason. */
	reason?: string;
	/** Active tab state after the operation (always fresh). */
	tab?: {
		id: string;
		url: string;
		title: string;
		readyState: string;
	};
	/** Console counts since the last drain (bounded, deduplicated). */
	console?: { errors: number; warnings: number; total: number; topFinding?: AiraBrowserFindingLike };
	/** Network failure counts since the last drain. */
	network?: { failures: number; topFinding?: AiraBrowserFindingLike };
	/** Compact page-change diff, when a mutation landed. */
	changes?: AiraBrowserChange[];
	/** Screenshot reference path, when captured. */
	screenshotPath?: string;
	/** One-line summary for operations that produce a value (evaluate). */
	summary?: string;
}

/** Minimal finding shape used inside operation results. */
export interface AiraBrowserFindingLike {
	message: string;
	source?: string;
	line?: number;
	count: number;
}

/** Bounded evidence drain (console or network inspection). */
export interface AiraBrowserEvidenceDrain {
	total: number;
	overflowed: boolean;
	records: AiraBrowserConsoleRecord[] | AiraBrowserNetworkRecord[];
	topFinding?: AiraBrowserFindingLike;
	/** Console: error count (deduplicated occurrences). */
	errors?: number;
	/** Console: warning count. */
	warnings?: number;
	/** Network: failure count. */
	failures?: number;
}

/** Wait conditions supported by browser_wait. */
export type AiraBrowserWaitCondition =
	| { kind: "time"; ms: number }
	| { kind: "selector"; selector: string }
	| { kind: "text"; text: string }
	| { kind: "url"; substring: string }
	| { kind: "ready"; readyState: "interactive" | "complete" };
