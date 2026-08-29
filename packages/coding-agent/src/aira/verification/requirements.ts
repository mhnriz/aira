/**
 * Aira verification — requirement model.
 *
 * Verification is requirement-driven: a bounded checklist derived from the
 * user's actual objective. The verifier model extracts requirements from
 * the objective (explicit = stated, inferred = necessary for the objective);
 * this module is the deterministic boundary that validates, bounds, dedupes,
 * and counts whatever the model emits, so the canonical result can never
 * carry an unbounded or malformed requirement list.
 */

import type {
	AiraRequirementKind,
	AiraRequirementStatus,
	AiraVerificationFinding,
	AiraVerificationRequirement,
	AiraVerificationResult,
	AiraVerificationScopeAssessment,
} from "./types.ts";

export const MAX_VERIFICATION_REQUIREMENTS = 8;
export const MAX_REQUIREMENT_TEXT_CHARS = 400;
export const MAX_FINDINGS = 12;
export const MAX_FINDING_MESSAGE_CHARS = 400;
export const MAX_FINDING_EVIDENCE_CHARS = 300;
export const MAX_EVIDENCE_ITEMS = 12;
export const MAX_EVIDENCE_LABEL_CHARS = 120;
export const MAX_EVIDENCE_SUMMARY_CHARS = 300;
export const MAX_MISSING_EVIDENCE_ITEMS = 8;
export const MAX_MISSING_EVIDENCE_CHARS = 200;
export const MAX_SCOPE_NOTES = 4;
export const MAX_SCOPE_NOTE_CHARS = 300;

const REQUIREMENT_KINDS: readonly AiraRequirementKind[] = ["explicit", "inferred"];
const REQUIREMENT_STATUSES: readonly AiraRequirementStatus[] = ["verified", "unmet", "unverifiable"];

/** Normalize an unknown requirement-list value into the bounded canonical shape. */
export function normalizeVerificationRequirements(value: unknown): AiraVerificationRequirement[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const out: AiraVerificationRequirement[] = [];
	for (const raw of value) {
		if (out.length >= MAX_VERIFICATION_REQUIREMENTS) {
			break;
		}
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const record = raw as Record<string, unknown>;
		const text = boundedString(record.text, MAX_REQUIREMENT_TEXT_CHARS);
		if (!text) {
			continue;
		}
		let id = typeof record.id === "string" ? record.id.trim() : "";
		if (!id) {
			// Deterministic fallback ids keep requirements traceable even when
			// the model omits them.
			id = `R${out.length + 1}`;
		}
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		const kind = REQUIREMENT_KINDS.includes(record.kind as AiraRequirementKind)
			? (record.kind as AiraRequirementKind)
			: "explicit";
		const status = REQUIREMENT_STATUSES.includes(record.status as AiraRequirementStatus)
			? (record.status as AiraRequirementStatus)
			: "unverifiable";
		out.push({ id, text, kind, status });
	}
	return out;
}

export function normalizeFindings(value: unknown): AiraVerificationFinding[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: AiraVerificationFinding[] = [];
	for (const raw of value) {
		if (out.length >= MAX_FINDINGS) {
			break;
		}
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const record = raw as Record<string, unknown>;
		const message = boundedString(record.message, MAX_FINDING_MESSAGE_CHARS);
		if (!message) {
			continue;
		}
		out.push({
			severity: record.severity === "blocking" || record.severity === "info" ? record.severity : "warning",
			requirementId: typeof record.requirementId === "string" ? boundedString(record.requirementId, 24) : undefined,
			message,
			evidence: boundedString(record.evidence, MAX_FINDING_EVIDENCE_CHARS),
		});
	}
	return out;
}

export function normalizeEvidenceItems(value: unknown): AiraVerificationResult["evidence"] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: AiraVerificationResult["evidence"] = [];
	for (const raw of value) {
		if (out.length >= MAX_EVIDENCE_ITEMS) {
			break;
		}
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const record = raw as Record<string, unknown>;
		const summary = boundedString(record.summary ?? record.text, MAX_EVIDENCE_SUMMARY_CHARS);
		if (!summary) {
			continue;
		}
		const category = record.category as AiraVerificationResult["evidence"][number]["category"];
		out.push({
			category: ["repository", "language", "execution", "browser", "git", "verifier"].includes(category)
				? category
				: "verifier",
			label: boundedString(record.label, MAX_EVIDENCE_LABEL_CHARS) ?? "",
			summary,
		});
	}
	return out;
}

export function normalizeMissingEvidence(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const raw of value) {
		if (out.length >= MAX_MISSING_EVIDENCE_ITEMS) {
			break;
		}
		const text = typeof raw === "string" ? boundedString(raw, MAX_MISSING_EVIDENCE_CHARS) : "";
		if (text && !out.includes(text)) {
			out.push(text);
		}
	}
	return out;
}

export function normalizeScopeAssessment(value: unknown): AiraVerificationScopeAssessment {
	if (!value || typeof value !== "object") {
		return { verdict: "uncertain", notes: [] };
	}
	const record = value as Record<string, unknown>;
	const verdict =
		record.verdict === "in-scope" || record.verdict === "drift" ? record.verdict : ("uncertain" as const);
	const notes: string[] = [];
	if (Array.isArray(record.notes)) {
		for (const raw of record.notes) {
			if (notes.length >= MAX_SCOPE_NOTES) {
				break;
			}
			const text = typeof raw === "string" ? boundedString(raw, MAX_SCOPE_NOTE_CHARS) : "";
			if (text) {
				notes.push(text);
			}
		}
	}
	return { verdict, notes };
}

/** Requirement counts for the UI snapshot (requirementsVerified is truthy-status count). */
export function countRequirementStatuses(requirements: readonly AiraVerificationRequirement[]): {
	total: number;
	verified: number;
} {
	let verified = 0;
	for (const requirement of requirements) {
		if (requirement.status === "verified") {
			verified += 1;
		}
	}
	return { total: requirements.length, verified };
}

function boundedString(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
