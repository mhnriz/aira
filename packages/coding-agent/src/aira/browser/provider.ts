/**
 * Aira browser — provider boundary.
 *
 * The browser manager (Aira-owned) never touches browser mechanics directly;
 * it drives a `AiraBrowserProvider`. This interface is the replaceable
 * boundary: today it is implemented by the native CDP/Chromium provider
 * (`cdp/`), a future phase could implement it over Playwright or a cloud
 * browser without touching Aira.
 *
 * Everything crossing this boundary is plain data. No Playwright/CDP objects
 * leak into Aira; operations return bounded structured results (types.ts).
 * The provider owns launch/connect mechanics, tab handles, and evidence
 * buffers; Aira owns activation, settings, eligibility, lifecycle, ownership,
 * evidence selection, and canonical state.
 */
import type {
	AiraBrowserEvidenceDrain,
	AiraBrowserObservation,
	AiraBrowserOperationResult,
	AiraBrowserWaitCondition,
} from "./types.ts";

export interface AiraBrowserAvailability {
	available: boolean;
	/** Provider id, e.g. "cdp-chromium". */
	provider: string;
	/** Human-readable resolution ("Google Chrome at /Applications/..."), when available. */
	detail?: string;
	/** Truthful reason when unavailable. */
	reason?: string;
}

export interface AiraBrowserElementTarget {
	/** Stable ref from a previous observation (preferred). */
	ref?: string;
	/** Fallback viewport coordinates (CSS px). */
	x?: number;
	y?: number;
}

export interface AiraBrowserOpenOptions {
	/** Initial URL to navigate to (loopback/localhost preferred). */
	url?: string;
	/** Bounded URL allowlist beyond the session scope; empty = loopback only. */
	extraAllowedOrigins?: readonly string[];
	/** Navigation timeout in ms (default provider-side). */
	timeoutMs?: number;
	/** Aira-owned profile directory. */
	profileDir: string;
	/** User-data-dir may already exist (reopen after crash). */
	reuseProfile?: boolean;
}

export interface AiraBrowserObserveOptions {
	maxNodes?: number;
	/** Outline character budget (default ~4000). */
	maxChars?: number;
	/** Include coordinates for interactive targets (default true). */
	withBoxes?: boolean;
	/** Drain console/network evidence into the result. */
	withEvidence?: boolean;
}

export interface AiraBrowserNavigateOptions {
	url: string;
	/** "domcontentloaded" (default) | "load" | "commit". */
	waitUntil?: "commit" | "domcontentloaded" | "load";
	timeoutMs?: number;
}

export interface AiraBrowserClickOptions extends AiraBrowserElementTarget {
	button?: "left" | "right" | "middle";
	count?: 1 | 2 | 3;
}

export interface AiraBrowserEvaluateOptions {
	/** Page expression (runs in the page's main world, returnByValue). */
	expression: string;
	/** Await promises before returning (default true). */
	awaitPromise?: boolean;
	timeoutMs?: number;
}

export interface AiraBrowserEvidenceFilter {
	levels?: Array<"error" | "warn" | "info" | "debug" | "log">;
	/** Since record seq (bounded drain cursor). */
	sinceSeq?: number;
	/** Max records (default 100). */
	limit?: number;
}

/** The replaceable provider boundary (see module doc). */
export interface AiraBrowserProvider {
	readonly id: string;
	/** Probe whether the provider can be used (cheap; cached by the manager). */
	probeAvailability(): Promise<AiraBrowserAvailability>;
	/** Open a browser session in the given isolated profile. */
	open(options: AiraBrowserOpenOptions): Promise<AiraBrowserOperationResult>;
	/** Close the whole browser session (kills Aira's own browser process). */
	close(): Promise<AiraBrowserOperationResult>;
	/** Get the current tab list (provider truth). */
	tabs(): Array<{ id: string; url: string; title: string; readyState: string }>;
	/** The active tab id (provider-side focus). */
	activeTabId(): string | undefined;
	/** Select an active tab. */
	activateTab(tabId: string): Promise<AiraBrowserOperationResult>;
	/** Close one tab (owned). */
	closeTab(tabId: string): Promise<AiraBrowserOperationResult>;
	/** Semantic page observation (bounded, refs, coordinates). */
	observe(tabId: string, options?: AiraBrowserObserveOptions): Promise<AiraBrowserObservation>;
	/** Navigate a tab; waits per waitUntil; returns fresh state + evidence. */
	navigate(tabId: string, options: AiraBrowserNavigateOptions): Promise<AiraBrowserOperationResult>;
	/** Resolve a ref to fresh coordinates; stale refs are truthful errors. */
	resolveTarget(tabId: string, ref: string): Promise<{ x: number; y: number; label: string }>;
	/** Click at a ref or coordinates (compositor-level). */
	click(tabId: string, options: AiraBrowserClickOptions): Promise<AiraBrowserOperationResult>;
	/** Fill/select/check a field by ref (framework-safe value setter). */
	fill(tabId: string, ref: string, value: string | boolean): Promise<AiraBrowserOperationResult>;
	/** Press a key (special keys, modifiers). */
	pressKey(tabId: string, key: string, modifiers?: number): Promise<AiraBrowserOperationResult>;
	/** Scroll by delta or to a target. */
	scroll(tabId: string, ref: string | undefined, deltaX: number, deltaY: number): Promise<AiraBrowserOperationResult>;
	/** Wait for a bounded condition; returns the state after waiting. */
	wait(tabId: string, condition: AiraBrowserWaitCondition, timeoutMs: number): Promise<AiraBrowserOperationResult>;
	/** Limited page evaluation (returnByValue). */
	evaluate(tabId: string, options: AiraBrowserEvaluateOptions): Promise<AiraBrowserOperationResult>;
	/** Console evidence (bounded, deduplicated). */
	consoleEvidence(tabId: string, filter?: AiraBrowserEvidenceFilter): Promise<AiraBrowserEvidenceDrain>;
	/** Network failure evidence (bounded, deduplicated). */
	networkEvidence(tabId: string, filter?: AiraBrowserEvidenceFilter): Promise<AiraBrowserEvidenceDrain>;
	/** Capture a screenshot to the Aira-managed directory; returns the path. */
	screenshot(tabId: string, dir: string, kind: string): Promise<string>;
	/** Kill the browser process, release the profile; safe to call twice. */
	dispose(): Promise<void>;
	/** Crash/exit notification for degraded-state reporting. */
	onBrowserExit(listener: (reason: string) => void): () => void;
}

/** Target resolution helper shared by provider callers. */
export function elementTargetLabel(target: AiraBrowserElementTarget): string {
	if (target.ref) {
		return `[${target.ref}]`;
	}
	if (target.x !== undefined && target.y !== undefined) {
		return `(${target.x}, ${target.y})`;
	}
	return "unknown target";
}
