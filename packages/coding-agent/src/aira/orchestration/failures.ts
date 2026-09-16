/**
 * Aira orchestration — deterministic child-failure classification.
 *
 * A failed child run today can mean two very different things:
 *
 * 1. the delegated TASK ran and the work failed (tests disproved the change,
 *    acceptance criteria unmet, artifact could not be produced), or
 * 2. the task could not RUN because a required Aira capability, provider,
 *    environment, or child-session mechanism was unavailable.
 *
 * Collapsing both into one "child failed" outcome makes the parent misdiagnose
 * infrastructure failure as task failure, retry the wrong thing, or rebuild a
 * failed native capability from primitives.
 *
 * Classification here is deterministic and evidence-based only: typed internal
 * errors, Node error codes, provider HTTP status/codes, explicit timeout state,
 * and cancellation state. No LLM classification, no embeddings, no confidence
 * scoring, and no regex classification over arbitrary prose. Unrecognized
 * errors stay `unknown_failure` rather than being guessed into a category.
 */

import type {
	AiraChildCapabilityGap,
	AiraChildFailureCategory,
	AiraChildFailureInfo,
	AiraChildFailureKind,
	AiraChildResultDiagnostics,
	AiraChildTaskExecutionStatus,
	AiraRetryableHint,
} from "./types.ts";

/**
 * Deterministic origin of a failure. Set by the seam that observed it:
 * `capability` = an Aira capability layer could not run the work,
 * `environment` = the execution environment prevented the work,
 * `task` = the execution capability worked but the delegated work failed.
 */
export type AiraFailureOrigin = "capability" | "environment" | "task" | "unknown";

/** Structured evidence extracted from a thrown value or a known seam. */
export interface AiraFailureEvidence {
	origin?: AiraFailureOrigin;
	message?: string;
	/** Node error code (`ENOENT`, `EACCES`, ...) or provider error code. */
	code?: string | number;
	/** Provider HTTP status when the provider layer exposed one. */
	status?: number;
	component?: string;
	operation?: string;
	taskStatus?: AiraChildTaskExecutionStatus;
	timedOut?: boolean;
	cancelled?: boolean;
	/** Required capabilities the runtime could not grant before the run. */
	capabilityGaps?: AiraChildCapabilityGap[];
	/** Bounded parse diagnostics when an unparseable result caused the failure. */
	diagnostics?: AiraChildResultDiagnostics;
}

/** Input for the legacy-compatible failure record (all fields optional). */
export interface AiraFailureInput {
	message: string;
	kind?: AiraChildFailureKind;
	category?: AiraChildFailureCategory;
	code?: string;
	component?: string;
	operation?: string;
	retryable?: boolean;
	retryableHint?: AiraRetryableHint;
	taskStatus?: AiraChildTaskExecutionStatus;
	capabilityGaps?: AiraChildCapabilityGap[];
	diagnostics?: AiraChildResultDiagnostics;
}

const MESSAGE_LIMIT = 600;

/**
 * Node error codes that mean the execution environment (not the delegated
 * work) prevented the operation: a missing executable/SDK, insufficient
 * permission, or an unsupported platform.
 */
const ENVIRONMENT_CODES = new Set([
	"ENOENT",
	"EACCES",
	"EPERM",
	"ENOSYS",
	"ENOTSUP",
	"EOPNOTSUPP",
	"EUNSUPPORTED",
	"ENOTFOUND",
	"EISDIR",
]);

/** Provider HTTP statuses worth retrying (advisory metadata only). */
function providerRetryableHint(status: number | undefined): AiraRetryableHint {
	if (status === undefined) return "unknown";
	if (status === 408 || status === 429 || status >= 500) return "yes";
	return "no";
}

function normalizeCode(code: string | number | undefined): string | undefined {
	if (code === undefined) return undefined;
	if (typeof code === "number") return String(code);
	const trimmed = code.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Redact secret-bearing material before a message is stored or shown.
 * Deterministic and narrow: header/key shapes, bearer/basic credentials, and
 * well-known key prefixes. Everything else is preserved as evidence.
 */
export function sanitizeAiraFailureMessage(message: string): string {
	let text = message;
	text = text.replace(
		/(authorization|proxy-authorization|x-api-key|api[-_]?key|cookie|set-cookie)("?\s*[:=]\s*)("?)([^\s"',;]+)/gi,
		"$1$2[redacted]",
	);
	text = text.replace(/\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, "$1 [redacted]");
	text = text.replace(/\b(sk|pk|rk)-[A-Za-z0-9\-_]{12,}/g, "[redacted]");
	text = text.replace(/\beyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{6,}/g, "[redacted]");
	text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
	if (text.length > MESSAGE_LIMIT) text = `${text.slice(0, MESSAGE_LIMIT)}…`;
	return text;
}

/** Build a legacy-compatible failure record with truthful defaults. */
export function buildAiraChildFailure(input: AiraFailureInput): AiraChildFailureInfo {
	const retryable = input.retryable ?? false;
	const retryableHint = input.retryableHint ?? (retryable ? "yes" : "unknown");
	return {
		kind: input.kind ?? "unknown_failure",
		category: input.category ?? "driver",
		message: sanitizeAiraFailureMessage(input.message),
		retryable,
		retryableHint,
		code: normalizeCode(input.code),
		component: input.component,
		operation: input.operation,
		taskStatus: input.taskStatus ?? "unknown",
		...(input.capabilityGaps && input.capabilityGaps.length > 0 ? { capabilityGaps: input.capabilityGaps } : {}),
		...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
	};
}

/**
 * Classify a failure from structured evidence.
 *
 * Rule order is fixed so the same evidence always yields the same kind:
 * cancellation, timeout, environment codes, known seam origin, provider
 * status, then unknown.
 */
export function classifyAiraChildFailure(evidence: AiraFailureEvidence): AiraChildFailureInfo {
	const message = evidence.message && evidence.message.trim().length > 0 ? evidence.message : "child run failed";
	const code = normalizeCode(evidence.code);
	const shared = {
		message,
		code,
		component: evidence.component,
		operation: evidence.operation,
		capabilityGaps: evidence.capabilityGaps,
		diagnostics: evidence.diagnostics,
	};

	if (evidence.cancelled) {
		return buildAiraChildFailure({
			...shared,
			kind: "cancelled",
			category: "cancelled",
			retryableHint: "no",
			taskStatus: evidence.taskStatus ?? "attempted",
		});
	}

	if (evidence.timedOut) {
		return buildAiraChildFailure({
			...shared,
			kind: "timeout",
			category: "timeout",
			retryableHint: "unknown",
			taskStatus: evidence.taskStatus ?? "attempted",
		});
	}

	if (code && ENVIRONMENT_CODES.has(code)) {
		return buildAiraChildFailure({
			...shared,
			kind: "environment_failure",
			category: code === "EACCES" || code === "EPERM" ? "permission-denied" : "driver",
			retryableHint: "no",
			component: evidence.component ?? "process",
			operation: evidence.operation ?? "launch",
			taskStatus: evidence.taskStatus ?? "not_attempted",
		});
	}

	const origin = evidence.origin ?? "unknown";
	if (origin === "task") {
		return buildAiraChildFailure({
			...shared,
			kind: "task_failure",
			category: "driver",
			retryableHint: "no",
			taskStatus: "attempted",
		});
	}

	if (origin === "environment") {
		return buildAiraChildFailure({
			...shared,
			kind: "environment_failure",
			category: "driver",
			retryableHint: "no",
			taskStatus: evidence.taskStatus ?? "not_attempted",
		});
	}

	if (origin === "capability") {
		const denied = evidence.status === 401 || evidence.status === 403;
		return buildAiraChildFailure({
			...shared,
			kind: "capability_failure",
			category: denied ? "permission-denied" : "driver",
			retryable: providerRetryableHint(evidence.status) === "yes",
			retryableHint: providerRetryableHint(evidence.status),
			taskStatus: evidence.taskStatus ?? "not_attempted",
		});
	}

	if (evidence.status !== undefined) {
		// A structured provider status without a known seam is still provider
		// capability evidence, never evidence that the delegated work failed.
		const hint = providerRetryableHint(evidence.status);
		return buildAiraChildFailure({
			...shared,
			kind: "capability_failure",
			category: evidence.status === 401 || evidence.status === 403 ? "permission-denied" : "driver",
			retryable: hint === "yes",
			retryableHint: hint,
			component: evidence.component ?? "provider",
			operation: evidence.operation ?? "request",
			taskStatus: evidence.taskStatus ?? "not_attempted",
		});
	}

	// No provenance, but a required capability was known to be unavailable when
	// the run launched: that is capability evidence, not task evidence.
	if (evidence.capabilityGaps && evidence.capabilityGaps.length > 0) {
		const gap = evidence.capabilityGaps[0];
		return buildAiraChildFailure({
			...shared,
			kind: "capability_failure",
			category: "driver",
			retryableHint: "no",
			component: evidence.component ?? gap.component,
			operation: evidence.operation ?? gap.operation,
			taskStatus: evidence.taskStatus ?? "not_attempted",
		});
	}

	return buildAiraChildFailure({ ...shared, kind: "unknown_failure", taskStatus: evidence.taskStatus ?? "unknown" });
}

function readField(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[key];
}

/**
 * Extract structured evidence from a thrown value.
 *
 * Only structured fields are read: Node `code`/`errno`/`status`/`statusCode`,
 * plus the origin declared by typed Aira capability/environment errors.
 */
export function toAiraFailureEvidence(error: unknown, fallbackMessage: string): AiraFailureEvidence {
	if (error instanceof AiraEnvironmentError) {
		return {
			origin: "environment",
			message: error.message,
			code: error.code,
			component: error.component,
			operation: error.operation,
		};
	}
	if (error instanceof AiraCapabilityError) {
		return {
			origin: "capability",
			message: error.message,
			code: error.code,
			component: error.component,
			operation: error.operation,
		};
	}
	if (error instanceof Error) {
		const code = readField(error, "code");
		const status = readField(error, "status") ?? readField(error, "statusCode");
		return {
			message: error.message.length > 0 ? error.message : fallbackMessage,
			code: typeof code === "string" || typeof code === "number" ? code : undefined,
			status: typeof status === "number" ? status : undefined,
		};
	}
	if (typeof error === "string" && error.trim().length > 0) {
		return { message: error };
	}
	return { message: fallbackMessage };
}

/**
 * A required Aira capability could not be used (child session, provider
 * request, native tool, orchestration transport).
 */
export class AiraCapabilityError extends Error {
	readonly airaFailureKind: AiraChildFailureKind = "capability_failure";
	readonly code: string | undefined;
	readonly component: string | undefined;
	readonly operation: string | undefined;

	constructor(message: string, options: { code?: string; component?: string; operation?: string } = {}) {
		super(message);
		this.name = "AiraCapabilityError";
		this.code = options.code;
		this.component = options.component;
		this.operation = options.operation;
	}
}

/**
 * The execution environment prevented the work (missing executable/SDK,
 * permission, unsupported platform, absent repository prerequisite).
 */
export class AiraEnvironmentError extends Error {
	readonly airaFailureKind: AiraChildFailureKind = "environment_failure";
	readonly code: string | undefined;
	readonly component: string | undefined;
	readonly operation: string | undefined;

	constructor(message: string, options: { code?: string; component?: string; operation?: string } = {}) {
		super(message);
		this.name = "AiraEnvironmentError";
		this.code = options.code;
		this.component = options.component;
		this.operation = options.operation;
	}
}
