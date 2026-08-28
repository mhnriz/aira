/**
 * Aira browser — bounded network failure evidence.
 *
 * Tracks requests per tab; only FAILURES are retained:
 * - `Network.loadingFailed` (aborted/blocked/timed-out/network error),
 * - 4xx and 5xx responses (relevant to verification),
 * - everything else is discarded once the request completes.
 *
 * Repeated identical failures dedupe into a count on the first record.
 * Summary counts + a top finding are always available; per-record detail is
 * drained on demand (bounded).
 */
import type { AiraBrowserEvidenceDrain, AiraBrowserFindingLike, AiraBrowserNetworkRecord } from "../types.ts";

const MAX_RECORDS = 100;
/** Cosmetic subresource failures (images/fonts/media) stay out of evidence. */
const EXCLUDE_RESOURCE_TYPES = new Set(["favicon", "image", "media", "font", "stylesheet"]);

export interface NetworkRequestWillBeSentParams {
	requestId?: string;
	request?: { url?: string; method?: string };
	type?: string;
}

export interface NetworkResponseReceivedParams {
	requestId?: string;
	type?: string;
	response?: { status?: number; statusText?: string; mimeType?: string };
}

export interface NetworkLoadingFailedParams {
	requestId?: string;
	errorText?: string;
	cancelled?: boolean;
	blockedReason?: string;
	type?: string;
}

export interface AiraNetworkBuffer {
	ingestRequestWillBeSent(params: NetworkRequestWillBeSentParams): void;
	ingestResponseReceived(params: NetworkResponseReceivedParams): void;
	ingestLoadingFailed(params: NetworkLoadingFailedParams): void;
	drain(sinceSeq?: number, limit?: number): AiraBrowserEvidenceDrain;
	summary(): { failures: number; topFinding?: AiraBrowserFindingLike };
	clear(): void;
}

interface RequestMeta {
	url: string;
	method: string;
	type: string;
}

function isNoisyType(type: string): boolean {
	return EXCLUDE_RESOURCE_TYPES.has(type.toLowerCase());
}

function isLocaljsTrampoline(url: string): boolean {
	// Extension/service-worker trampolines and source maps are not app
	// failures; a handful would otherwise dominate verification evidence.
	return url.includes("/__vite") || url.includes("webpack-hmr") || url.endsWith(".map");
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname || undefined;
	} catch {
		return undefined;
	}
}

export function createAiraNetworkBuffer(
	capacity = MAX_RECORDS,
	now: () => number = () => Date.now(),
): AiraNetworkBuffer {
	const records: AiraBrowserNetworkRecord[] = [];
	const inFlight = new Map<string, RequestMeta>();
	let dropped = 0;
	let nextSeq = 1;

	const insert = (record: AiraBrowserNetworkRecord): void => {
		const existing = records.find(
			(r) =>
				r.method === record.method &&
				r.url === record.url &&
				r.status === record.status &&
				r.errorText === record.errorText,
		);
		if (existing) {
			existing.count += 1;
			existing.lastAt = record.firstAt;
			return;
		}
		if (records.length >= capacity) {
			records.shift();
			dropped += 1;
		}
		records.push({ ...record, seq: nextSeq++ });
	};

	const topFinding = (): AiraBrowserFindingLike | undefined => {
		if (records.length === 0) return undefined;
		const record = records[0];
		return {
			message: record.errorText
				? `${record.method} ${record.url} — ${record.errorText}`
				: `${record.method} ${record.url} — HTTP ${record.status ?? "?"}`,
			source: hostOf(record.url),
			count: record.count,
		};
	};

	return {
		ingestRequestWillBeSent(params) {
			const id = params.requestId;
			const url = params.request?.url;
			const method = params.request?.method;
			if (!id || !url || !method) return;
			inFlight.set(id, { url, method, type: params.type ?? "Other" });
		},
		ingestResponseReceived(params) {
			const meta = params.requestId ? inFlight.get(params.requestId) : undefined;
			if (!meta) return;
			const status = params.response?.status;
			if (status === undefined || status < 400) return;
			if (isNoisyType(meta.type) || isLocaljsTrampoline(meta.url)) return;
			insert({
				requestId: params.requestId ?? "",
				seq: 0,
				method: meta.method,
				url: meta.url,
				status,
				resourceType: meta.type,
				firstAt: now(),
				lastAt: now(),
				count: 1,
			});
		},
		ingestLoadingFailed(params) {
			const meta = params.requestId ? inFlight.get(params.requestId) : undefined;
			if (!meta) return;
			if (params.requestId) inFlight.delete(params.requestId);
			const url = meta.url;
			if (!url) return;
			if (isNoisyType(params.type ?? meta.type)) return;
			if (isLocaljsTrampoline(url)) return;
			const errorText =
				params.blockedReason !== undefined
					? `blocked (${params.blockedReason})`
					: params.cancelled
						? "cancelled"
						: (params.errorText ?? "failed");
			insert({
				requestId: params.requestId ?? "",
				seq: 0,
				method: meta.method,
				url,
				errorText,
				resourceType: meta.type,
				firstAt: now(),
				lastAt: now(),
				count: 1,
			});
		},
		drain(sinceSeq?: number, limit = 100) {
			const matched = records
				.filter((r) => sinceSeq === undefined || r.seq > sinceSeq)
				.slice(0, limit)
				.map((r) => ({ ...r }));
			const failures = records.reduce((n, r) => n + r.count, 0);
			return {
				total: records.length + dropped,
				overflowed: dropped > 0,
				records: matched,
				topFinding: topFinding(),
				failures: failures + dropped,
			};
		},
		summary() {
			const failures = records.reduce((n, r) => n + r.count, 0);
			return { failures: failures + dropped, topFinding: topFinding() };
		},
		clear() {
			records.length = 0;
			inFlight.clear();
			dropped = 0;
			nextSeq = 1;
		},
	};
}
