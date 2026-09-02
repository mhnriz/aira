/**
 * Aira permissions — deterministic permission presentation (UI-only).
 *
 * Pure, host-side, token-free derivation of what the permission card shows.
 * Nothing here evaluates policy: it consumes the canonical Phase 11 request
 * (`AiraPermissionRequest`), the deterministic evaluation outcome
 * (`AiraPermissionEvaluation`), and host facts the controller already owns
 * (cwd, project root, tool args). The output is a bounded, redacted,
 * UI-ready `AiraPermissionPresentation` attached to the pending
 * permission interaction and projected by the TUI card, the Workbench
 * sidebar, and the footer.
 *
 * Contract:
 * - tool-aware formatting: process commands show the command, path tools
 *   show the resolved target + workspace scope, browser tools show the
 *   target/kind, unknown extension tools show the tool name and up to 3
 *   bounded parameter rows;
 * - deterministic reasons only: default-category wording (risk-marker
 *   classification, out-of-workspace write, browser interaction, unknown
 *   tool) or the rule-match reason verbatim — never model prose;
 * - redaction: command text and parameter values pass through
 *   `redactVerificationSecrets` (private keys, authorization headers,
 *   tokens, JWT/credentials shapes); secret-like parameter KEYS are
 *   masked entirely;
 * - bounds: subject ≤ 400 chars, summary ≤ 60 chars, ≤ 4 detail rows.
 */

import { type AiraClassifiedCapability, airaCapabilityClassLabel } from "../capabilities.ts";
import { redactVerificationSecrets } from "../verification/evidence.ts";
import { classifyAiraRiskyCommand, isPathWithin } from "./policy.ts";
import type { AiraPermissionEvaluation } from "./types.ts";

export interface AiraPermissionPresentationRow {
	/** Short label ("Working directory", "Scope", ...). */
	label: string;
	/** Bounded value text (redacted where applicable). */
	value: string;
}

/** Bounded permission card data (UI projection only; never policy input). */
export interface AiraPermissionPresentation {
	/** Tool/action name (e.g. "bash", "write", "browser_click"). */
	tool: string;
	/** Capability class label ("process", "mutating", "browser", "unknown", ...). */
	capability: string;
	/** Operation label ("Shell command", "Write file", "Browser interaction", ...). */
	operation: string;
	/** Display subject: command text / resolved path / tool name (redacted, bounded). */
	subject: string;
	/** True when secret-like content was masked from the subject or details. */
	redacted: boolean;
	/** Deterministic reason ASK was triggered ("remote repository operation", ...). */
	reason: string;
	/** Deterministic metadata rows (bounded). */
	details: readonly AiraPermissionPresentationRow[];
	/** True for out-of-workspace path targets (mutating tools). */
	outsideWorkspace?: boolean;
	/** One-line summary for restrained surfaces (footer/sidebar). */
	summary: string;
}

const MAX_SUBJECT_CHARS = 400;
const MAX_SUMMARY_CHARS = 60;
const MAX_DETAIL_ROWS = 4;
const MAX_DETAIL_VALUE_CHARS = 120;
const MAX_PARAM_VALUE_CHARS = 60;
const MAX_PARAM_ROWS = 3;

/** Secret-like parameter keys that are masked outright (never displayed). */
const SECRET_PARAM_KEYS =
	/^(api[_-]?key|password|passwd|pwd|secret|token|authorization|cookie|set-?cookie|credential|private[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|connection[_-]?string)$/i;

export interface AiraPermissionPresentationInput {
	tool: string;
	capability: AiraClassifiedCapability;
	/** Semantic browser operation kind (browser tools only). */
	browserOperation?: string;
	/** Raw matching subject (command / resolved path / tool name). */
	subject: string | undefined;
	/** Original tool args (for tool-aware detail rows). */
	args: Record<string, unknown>;
	/** The deterministic evaluation that decided ASK. */
	evaluation: AiraPermissionEvaluation;
	/** Session working directory. */
	cwd: string;
	/** Canonical project root (mutating scope boundary). */
	projectRoot: string | undefined;
}

/** Build the bounded permission presentation (pure; never throws). */
export function buildAiraPermissionPresentation(input: AiraPermissionPresentationInput): AiraPermissionPresentation {
	const subject = input.subject ?? input.tool;
	const maskedSubject = redactVerificationSecrets(subject);
	const redacted = maskedSubject !== subject;
	const redactedSubject = boundText(maskedSubject, MAX_SUBJECT_CHARS);
	const details: AiraPermissionPresentationRow[] = [];
	let outsideWorkspace: boolean | undefined;

	switch (input.capability) {
		case "process":
			details.push({ label: "Working directory", value: boundText(input.cwd, MAX_DETAIL_VALUE_CHARS) });
			if (input.tool === "process_start") {
				const mode = input.args.background === true ? "background" : "foreground";
				details.push({ label: "Launch", value: mode });
			}
			break;
		case "mutating": {
			const target = redactedSubject;
			const inScope = input.projectRoot === undefined || isPathWithin(target, input.projectRoot);
			outsideWorkspace = !inScope && input.projectRoot !== undefined;
			details.push({ label: "Target", value: target });
			details.push({
				label: "Scope",
				value:
					input.projectRoot === undefined ? "undetermined" : inScope ? "inside workspace" : "outside workspace",
			});
			break;
		}
		case "browser": {
			const target = browserTarget(input.args);
			if (target) {
				details.push({
					label: "Target",
					value: boundText(redactVerificationSecrets(target), MAX_DETAIL_VALUE_CHARS),
				});
			}
			details.push({ label: "Kind", value: input.browserOperation ?? "interaction" });
			break;
		}
		case "unknown": {
			for (const [key, value] of Object.entries(input.args)) {
				if (details.length >= MAX_PARAM_ROWS) {
					break;
				}
				details.push({ label: boundText(key, 24), value: boundedParamValue(key, value) });
			}
			break;
		}
		default:
			break;
	}

	const reason = reasonFor(input);

	return {
		tool: input.tool,
		capability: airaCapabilityClassLabel(input.capability),
		operation: operationLabel(input.tool, input.capability, input.browserOperation),
		subject: redactedSubject,
		redacted,
		reason: boundText(reason, MAX_DETAIL_VALUE_CHARS),
		details: details.slice(0, MAX_DETAIL_ROWS),
		...(outsideWorkspace !== undefined ? { outsideWorkspace } : {}),
		summary: boundText(redactedSubject, MAX_SUMMARY_CHARS),
	};
}

/** Deterministic reason wording from the evaluation outcome. */
function reasonFor(input: AiraPermissionPresentationInput): string {
	const evaluation = input.evaluation;
	if (evaluation.defaultCategory === undefined) {
		// A matched rule decided ASK (or a non-default path) — verbatim
		// canonical reason, bounded by the caller.
		return evaluation.reason;
	}
	const category = evaluation.defaultCategory;
	if (category === "process:risk-marker") {
		const classified = classifyAiraRiskyCommand(redactVerificationSecrets(input.subject ?? ""));
		if (classified) {
			return classified;
		}
		return "command matched ASK policy";
	}
	if (category === "mutating:out-of-scope") {
		return "write outside workspace";
	}
	if (category === "browser:interact") {
		return "browser interaction may trigger page side effects";
	}
	if (category === "unknown") {
		return "unknown extension tool";
	}
	if (category === "network") {
		return "network-class tool";
	}
	if (category === "browser:lifecycle") {
		return "browser lifecycle operation";
	}
	// Any other default category falls back to the canonical reason wording
	// (the presentation layer redacts what it shows; reasons carry no subject
	// text beyond the tool name).
	return evaluation.reason;
}

function operationLabel(
	tool: string,
	capability: AiraClassifiedCapability,
	browserOperation: string | undefined,
): string {
	switch (capability) {
		case "process":
			if (tool === "process_start") return "Start process";
			if (tool === "process_stop") return "Stop process";
			return "Shell command";
		case "mutating":
			if (tool === "write") return "Write file";
			if (tool === "edit") return "Edit file";
			return "File operation";
		case "browser":
			switch (browserOperation) {
				case "observe":
					return "Browser observation";
				case "navigate":
					return "Browser navigation";
				case "lifecycle":
					return "Browser lifecycle";
				default:
					return "Browser interaction";
			}
		case "network":
			return "Network request";
		case "unknown":
			return "Extension tool";
		default:
			return airaCapabilityClassLabel(capability);
	}
}

/** Best deterministic target text for browser tools (URL/domain when known). */
function browserTarget(args: Record<string, unknown>): string | undefined {
	const url = typeof args.url === "string" ? args.url : undefined;
	const domain = typeof args.domain === "string" ? args.domain : undefined;
	if (url && url.trim() !== "") {
		return url;
	}
	if (domain && domain.trim() !== "") {
		return domain;
	}
	return undefined;
}

/** Bound + redact one unknown-tool parameter value; mask secret keys. */
function boundedParamValue(key: string, value: unknown): string {
	if (SECRET_PARAM_KEYS.test(key.trim())) {
		return "[REDACTED]";
	}
	if (value === undefined || value === null) {
		return "null";
	}
	if (typeof value === "string") {
		return boundText(redactVerificationSecrets(value), MAX_PARAM_VALUE_CHARS) || "…";
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	// Objects/arrays: stable compact JSON, bounded — never an unbounded dump.
	try {
		const json = JSON.stringify(value);
		if (json === undefined) {
			return "…";
		}
		return boundText(redactVerificationSecrets(json), MAX_PARAM_VALUE_CHARS) || "…";
	} catch {
		return "…";
	}
}

function boundText(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 1)}…`;
}
