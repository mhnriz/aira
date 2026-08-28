/**
 * Aira browser — bounded console evidence.
 *
 * Captures `Runtime.consoleAPICalled` + `Log.entryAdded` per tab into a
 * bounded ring, deduplicates repeated identical messages (count kept on the
 * first record), and always yields summary counts + a top finding. Routine
 * `console.log` traffic is retained only as counts; the finding detail is
 * the actionable first error (or warning when no error exists).
 */
import type { AiraBrowserConsoleRecord, AiraBrowserEvidenceDrain, AiraBrowserFindingLike } from "../types.ts";

const MAX_RECORDS = 200;
const PER_ARG_CAP = 500;

export interface ConsoleEventParams {
	type?: string;
	args?: Array<{
		type?: string;
		subtype?: string;
		value?: unknown;
		description?: string;
		unserializableValue?: string;
	}>;
	stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; functionName?: string }> };
}

export interface LogEntryParams {
	entry?: {
		level?: string;
		text?: string;
		url?: string;
		lineNumber?: number;
		stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; functionName?: string }> };
	};
}

export interface AiraConsoleBuffer {
	ingestConsoleApi(params: ConsoleEventParams): void;
	ingestLogEntry(params: LogEntryParams): void;
	drain(sinceSeq?: number, limit?: number): AiraBrowserEvidenceDrain;
	summary(): { errors: number; warnings: number; total: number; topFinding?: AiraBrowserFindingLike };
	clear(): void;
}

function mapConsoleLevel(type: string | undefined): AiraBrowserConsoleRecord["level"] {
	switch (type) {
		case "error":
		case "assert":
			return "error";
		case "warning":
			return "warn";
		case "debug":
		case "trace":
			return "debug";
		case "info":
			return "info";
		default:
			return "log";
	}
}

function mapLogLevel(level: string | undefined): AiraBrowserConsoleRecord["level"] {
	switch (level) {
		case "error":
			return "error";
		case "warning":
			return "warn";
		case "verbose":
			return "debug";
		default:
			return "info";
	}
}

function stringifyArg(arg: NonNullable<ConsoleEventParams["args"]>[number]): string {
	if (arg.unserializableValue !== undefined) return arg.unserializableValue;
	if (arg.value !== undefined) {
		if (typeof arg.value === "string") return arg.value;
		try {
			return JSON.stringify(arg.value);
		} catch {
			return String(arg.value);
		}
	}
	if (arg.description !== undefined) return arg.description;
	return arg.type ?? "";
}

function topFrame(stackTrace: ConsoleEventParams["stackTrace"]): { url?: string; line?: number } {
	const frame = stackTrace?.callFrames?.[0];
	if (!frame?.url) return {};
	return { url: frame.url, line: frame.lineNumber !== undefined ? frame.lineNumber + 1 : undefined };
}

export function createAiraConsoleBuffer(capacity = MAX_RECORDS): AiraConsoleBuffer {
	const records: AiraBrowserConsoleRecord[] = [];
	let nextSeq = 1;
	let dropped = 0;

	const insert = (
		level: AiraBrowserConsoleRecord["level"],
		text: string,
		source: string | undefined,
		line: number | undefined,
	): void => {
		const now = Date.now();
		const existing = records.find(
			(r) => r.level === level && r.text === text && r.source === source && r.line === line,
		);
		if (existing) {
			existing.count += 1;
			existing.lastAt = now;
			return;
		}
		if (records.length >= capacity) {
			records.shift();
			dropped += 1;
		}
		records.push({
			seq: nextSeq++,
			level,
			text: text.length > PER_ARG_CAP ? `${text.slice(0, PER_ARG_CAP)}…` : text,
			source,
			line,
			firstAt: now,
			lastAt: now,
			count: 1,
		});
	};

	const topFinding = (): AiraBrowserFindingLike | undefined => {
		if (records.length === 0) return undefined;
		const error = records.find((r) => r.level === "error");
		const record = error ?? records.find((r) => r.level === "warn");
		if (!record) return undefined;
		return {
			message: record.text,
			source: record.source,
			line: record.line,
			count: record.count,
		};
	};

	const summary = (): { errors: number; warnings: number; total: number; topFinding?: AiraBrowserFindingLike } => {
		const errors = records.filter((r) => r.level === "error").reduce((n, r) => n + r.count, 0);
		const warnings = records.filter((r) => r.level === "warn").reduce((n, r) => n + r.count, 0);
		const total = records.reduce((n, r) => n + r.count, 0);
		return {
			errors,
			warnings,
			total: total + dropped,
			topFinding: topFinding(),
		};
	};

	return {
		ingestConsoleApi(params) {
			const level = mapConsoleLevel(params.type);
			const text = (params.args ?? [])
				.map((a) => stringifyArg(a))
				.join(" ")
				.trim();
			if (!text) return;
			const frame = topFrame(params.stackTrace);
			insert(level, text, frame.url, frame.line);
		},
		ingestLogEntry(params) {
			const entry = params.entry;
			if (!entry?.text) return;
			const level = mapLogLevel(entry.level);
			const frame = topFrame(entry.stackTrace);
			const source = entry.url ?? frame.url;
			const line = entry.lineNumber !== undefined ? entry.lineNumber + 1 : frame.line;
			insert(level, entry.text, source, line);
		},
		drain(sinceSeq, limit = 100) {
			const matched = records.filter((r) => sinceSeq === undefined || r.seq > sinceSeq).slice(0, limit);
			const counts = summary();
			return {
				total: records.length + dropped,
				overflowed: dropped > 0,
				records: matched.map((r) => ({ ...r })),
				topFinding: topFinding(),
				errors: counts.errors,
				warnings: counts.warnings,
			};
		},
		summary,
		clear() {
			records.length = 0;
			nextSeq = 1;
			dropped = 0;
		},
	};
}
