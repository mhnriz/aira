/**
 * Aira browser — local URL discovery.
 *
 * The default browser verification target is a local development app. URL
 * evidence is gathered in priority order WITHOUT scanning networks:
 *
 *   1. Phase 6 managed dev-process output (parse real dev-server lines);
 *   2. explicit project configuration (future: profile hints; today: none);
 *   3. known framework conventions (vite → 5173, next/cra → 3000, ...);
 *
 * Only loopback hosts are accepted (localhost, 127.x, [::1], 0.0.0.0). If
 * nothing can be determined confidently the caller reports needs-url /
 * not-ready truthfully instead of guessing ports.
 */
import type { AiraProjectProfile } from "../project/profile.ts";

const LOCAL_URL_PATTERN =
	/\bhttps?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?(?:[/?#][^\s"'<>]*)?/gi;

/** Lines dev servers print that carry the app URL (vite/next/cra/webpack/...). */
const URL_HINT_LINES = [
	/\b(?:Local|Local:|App running at|Server ready at|listening on|on network|➜\s*Local|ready in|started server on)\b.*/i,
];

/** Deterministic framework default ports (only used when no output evidence). */
export function conventionalDevPorts(profile: AiraProjectProfile | undefined): readonly number[] {
	if (!profile) return [];
	const frameworks = new Set(profile.frameworks.map((f) => f.toLowerCase()));
	const ports: number[] = [];
	if (frameworks.has("vite")) ports.push(5173);
	if (frameworks.has("next")) ports.push(3000);
	if (frameworks.has("react")) ports.push(3000);
	if (frameworks.has("vue")) ports.push(8080);
	if (frameworks.has("angular")) ports.push(4200);
	if (frameworks.has("svelte")) ports.push(5173);
	if (frameworks.has("webpack")) ports.push(8080);
	if (frameworks.has("docusaurus")) ports.push(3000);
	return [...new Set(ports)];
}

/**
 * Extract local application URLs from dev-server output. Bounded: at most
 * `maxUrls` distinct loopback URLs, deduplicated, in first-seen order.
 */
export function localUrlsFromDevOutput(output: string, maxUrls = 3): string[] {
	const found = new Map<string, string>();
	for (const line of output.split("\n")) {
		if (!URL_HINT_LINES.some((hint) => hint.test(line)) && !LOOPBACK_URL.test(line)) {
			continue;
		}
		for (const match of line.matchAll(LOCAL_URL_PATTERN)) {
			const url = normalizeLocalUrl(match[0]);
			if (url) found.set(url, url);
		}
		if (found.size >= maxUrls) break;
	}
	return [...found.values()];
}

const LOOPBACK_URL = /\bhttps?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?\b/i;

function normalizeLocalUrl(raw: string): string | undefined {
	const cleaned = raw.replace(/[),;:]+$/, "").replace(/^[("[]+/, "");
	try {
		const url = new URL(cleaned);
		if (!isLoopbackHost(url.hostname)) return undefined;
		url.hostname = url.hostname === "0.0.0.0" ? "localhost" : url.hostname;
		const path = url.pathname.replace(/\/+$/, "");
		return path ? url.origin + path : url.origin;
	} catch {
		return undefined;
	}
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]" || host === "0.0.0.0";
}

export interface AiraBrowserUrlEvidence {
	/** Determined URL, when confident. */
	url?: string;
	/** Confidence: "output" (dev-process evidence) | "convention" | "none". */
	confidence: "output" | "convention" | "none";
	/** Where the evidence came from (diagnostics). */
	detail?: string;
}

/**
 * Resolve the best local URL for the current session.
 *
 * `output` is the concatenated stdout+stderr of the associated managed dev
 * process (Phase 6 evidence). Falls back to framework conventions only when
 * no output evidence exists. Never probes the network.
 */
export function discoverLocalUrl(output: string, profile: AiraProjectProfile | undefined): AiraBrowserUrlEvidence {
	const fromOutput = localUrlsFromDevOutput(output);
	if (fromOutput.length > 0) {
		return { url: fromOutput[0], confidence: "output", detail: "dev process output" };
	}
	const ports = conventionalDevPorts(profile);
	if (ports.length > 0 && profile?.root) {
		return {
			url: `http://localhost:${ports[0]}`,
			confidence: "convention",
			detail: `conventional ${profile.frameworks.join("/")} port`,
		};
	}
	return { confidence: "none", detail: "no local URL evidence (no dev process output, no framework convention)" };
}

/** True when a URL is a safe loopback target for automatic verification. */
export function isSafeLocalUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname);
	} catch {
		return false;
	}
}
