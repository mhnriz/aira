/**
 * Aira permissions — deterministic authorization policy (pure).
 *
 * A small pure evaluation core (no I/O, no session state): given a
 * normalized request (tool + capability class + subject), the permission
 * mode, and the explicit rule list, it returns a deterministic outcome.
 * Host-side and token-free by construction: nothing here prompts, persists,
 * or consults a model.
 *
 * Precedence (documented contract):
 *   1. host safety boundary — PLAN mode blocks mutating/process/browser-
 *      interaction regardless of permission mode or rules (absolute);
 *   2. explicit rules — most specific match wins (exact subject beats
 *      wildcard subject), ties broken by most-recent rule; a matched rule
 *      overrides mode defaults. In `yolo`, an explicit "ask" rule
 *      auto-approves (still: deny rules stay deny);
 *   3. permission-mode defaults by capability class (see types.ts).
 *
 * The `normal` mode's process default is subject-aware: a bounded,
 * deterministic risk-marker table (see module doc) decides which commands
 * ask. Markers are substrings of the normalized command — never regex
 * evaluation of user input beyond the bounded wildcard matcher.
 */

import { isAbsolute, normalize, relative, resolve } from "node:path";
import type {
	AiraPermissionEvaluation,
	AiraPermissionMode,
	AiraPermissionRequest,
	AiraPermissionRule,
} from "./types.ts";

const MAX_WILDCARD_PATTERN_CHARS = 300;

/** Every built-in mode label. */
export const AIRA_PERMISSION_MODE_LABELS: Record<AiraPermissionMode, string> = {
	normal: "normal",
	permissive: "permissive",
	strict: "strict",
	yolo: "yolo",
};

/** Short chip labels for the future footer ("PERM default" etc). */
export const AIRA_PERMISSION_MODE_CHIPS: Record<AiraPermissionMode, string> = {
	normal: "default",
	permissive: "edits",
	strict: "strict",
	yolo: "yolo",
};

/**
 * Deterministic risk markers for the `normal` mode process default.
 *
 * Substring markers over the normalized command (lowercased, whitespace
 * collapsed). Every marker is reviewed in the Phase 11 report/ADR; the list
 * is intentionally small and conservative — routine engineering commands
 * (tests, builds, dev servers, git status/diff/log, editors) never match.
 */
const RISK_MARKERS: readonly string[] = [
	// git consequences
	"git push",
	"git commit",
	"git reset --hard",
	"git clean",
	"git rebase",
	// dependency installation (mutates manifests/lockfiles, network)
	"npm install",
	"npm i ",
	"npm ci",
	"npx playwright install",
	"pnpm add",
	"pnpm install",
	"yarn add",
	"yarn install",
	"bun add",
	"bun install",
	"pip install",
	"pipx install",
	"uv pip install",
	"uv add",
	"poetry add",
	// destructive / system-level process behavior
	"rm -rf",
	"rm -fr",
	"rm -r",
	"rm -f /",
	"sudo",
	"dd ",
	"mkfs",
	"fdisk",
	"kill -9",
	"killall -9",
	"chmod -r",
	"chown -r",
	"curl | sh",
	"curl | bash",
	"wget | sh",
	"wget | bash",
	"shutdown",
	"poweroff",
	"reboot",
	"npm publish",
	"pnpm publish",
	// secret-adjacent reads (ask; explicit rules decide)
	"~/.ssh",
	"id_rsa",
	"~/.aws",
];

function normalizeSubjectForMarkers(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Deterministic piping marker: curl/wget piped straight into a shell. */
const PIPE_TO_SHELL_MARKER = /\b(curl|wget)\b.*\|\s*(sh|bash)\b/;

/** True when a process command carries a built-in risk marker (normal mode). */
export function isAiraRiskyCommand(command: string): boolean {
	const normalized = normalizeSubjectForMarkers(command);
	if (normalized.length === 0) {
		return false;
	}
	if (RISK_MARKERS.some((marker) => normalized.includes(marker))) {
		return true;
	}
	return PIPE_TO_SHELL_MARKER.test(normalized);
}

/** Normalize a raw permission-mode value (unknown → "normal"). */
export function normalizeAiraPermissionMode(value: unknown): AiraPermissionMode {
	if (value === "normal" || value === "permissive" || value === "strict" || value === "yolo") {
		return value;
	}
	return "normal";
}

/** Capability classes that are always allowed in every mode. */
const ALWAYS_ALLOWED_CLASSES = new Set(["read-only", "diagnostic", "orchestration", "interaction"]);

/** Browser operation kinds that behave like read-only surface in every mode. */
const SAFE_BROWSER_KINDS = new Set(["observe", "navigate"]);

/**
 * Evaluate one tool/action request deterministically. Pure: no I/O, no
 * prompting, no state mutation.
 */
export function evaluateAiraPermissionRequest(
	request: AiraPermissionRequest,
	options: { mode: AiraPermissionMode; rules: readonly AiraPermissionRule[]; plan?: boolean; projectRoot?: string },
): AiraPermissionEvaluation {
	const { mode, rules } = options;
	const capability = request.capability;

	// 1. Host safety boundary: PLAN is read-only, absolutely.
	if (options.plan === true) {
		const planBlocked = capability === "mutating" || capability === "process" || capability === "network";
		if (planBlocked) {
			return {
				action: "deny",
				reason: `PLAN mode is read-only: ${request.tool} is blocked at the host boundary (permissions cannot override PLAN)`,
			};
		}
		if (capability === "browser") {
			const kind = request.browserOperation ?? "observe";
			if (!SAFE_BROWSER_KINDS.has(kind)) {
				return {
					action: "deny",
					reason: `PLAN mode is read-only: ${request.tool} (${kind}) is blocked at the host boundary`,
				};
			}
		}
	}

	// 2. Explicit rules (most specific match wins; ties → most recent).
	const matched = matchBestRule(request, rules);
	if (matched) {
		let action = matched.rule.action;
		if (mode === "yolo" && action === "ask") {
			action = "allow";
		}
		return {
			action,
			reason: ruleReason(request.tool, matched.rule, action),
			matchedRuleId: matched.rule.id,
		};
	}

	// 3. Mode defaults by capability class.
	const result = modeDefault(mode, request, options.projectRoot);
	return result;
}

interface MatchedRule {
	rule: AiraPermissionRule;
	/** exact > wildcard specificity. */
	specificity: 0 | 1;
}

function matchBestRule(request: AiraPermissionRequest, rules: readonly AiraPermissionRule[]): MatchedRule | undefined {
	const subject = request.subject ?? request.tool;
	let best: MatchedRule | undefined;
	for (const rule of rules) {
		if (rule.tool !== request.tool) {
			continue;
		}
		const matches = rule.match === "exact" ? subject === rule.subject : wildcardMatch(rule.subject, subject);
		if (!matches) {
			continue;
		}
		const specificity: 0 | 1 = rule.match === "exact" ? 1 : 0;
		if (
			!best ||
			specificity > best.specificity ||
			(specificity === best.specificity && rule.createdAt >= best.rule.createdAt)
		) {
			best = { rule, specificity };
		}
	}
	return best;
}

/** Bounded wildcard matcher: `*` = any run, `?` = one char; anchored. */
export function wildcardMatch(pattern: string, subject: string): boolean {
	if (pattern.length > MAX_WILDCARD_PATTERN_CHARS || subject.length > 4096) {
		return false;
	}
	let regex = "^";
	for (const char of pattern) {
		if (char === "*") {
			regex += ".*";
		} else if (char === "?") {
			regex += ".";
		} else if ("\\^$+{}()[]|.".includes(char)) {
			regex += `\\${char}`;
		} else {
			regex += char;
		}
	}
	regex += "$";
	try {
		return new RegExp(regex).test(subject);
	} catch {
		return false;
	}
}

function ruleReason(tool: string, rule: AiraPermissionRule, action: string): string {
	const scope = rule.scope === "persistent" ? "persistent rule" : "session rule";
	const subject = rule.subject === tool ? "" : ` for ${previewSubject(rule.subject)}`;
	return `${tool} ${action}ed by ${scope}${subject} (${rule.id.slice(0, 8)})`;
}

/** Mode-default table (documented in types.ts). */
function modeDefault(
	mode: AiraPermissionMode,
	request: AiraPermissionRequest,
	projectRoot: string | undefined,
): AiraPermissionEvaluation {
	const capability = request.capability;
	const allow = (category: string): AiraPermissionEvaluation => ({
		action: "allow",
		reason: defaultReason(request.tool, "allow", category),
		defaultCategory: category,
	});
	const ask = (category: string): AiraPermissionEvaluation => ({
		action: "ask",
		reason: defaultReason(request.tool, "ask", category),
		defaultCategory: category,
	});
	const deny = (category: string): AiraPermissionEvaluation => ({
		action: "deny",
		reason: defaultReason(request.tool, "deny", category),
		defaultCategory: category,
	});

	if (ALWAYS_ALLOWED_CLASSES.has(capability)) {
		return allow(capability);
	}
	if (capability === "browser") {
		const kind = request.browserOperation ?? "observe";
		if (SAFE_BROWSER_KINDS.has(kind)) {
			return allow(`browser:${kind}`);
		}
		switch (mode) {
			case "normal":
				return ask("browser:interact");
			case "permissive":
			case "yolo":
				return allow("browser:interact");
			case "strict":
				return deny("browser:interact");
		}
	}
	if (capability === "mutating") {
		const subject = request.subject;
		const inScope = subject === undefined || projectRoot === undefined || isPathWithin(subject, projectRoot);
		if (mode === "strict") {
			return deny("mutating");
		}
		if (inScope) {
			return allow("mutating:workspace");
		}
		switch (mode) {
			case "normal":
				return ask("mutating:out-of-scope");
			case "permissive":
			case "yolo":
				return allow("mutating:out-of-scope");
		}
	}
	if (capability === "process") {
		const subject = request.subject ?? "";
		if (mode === "normal" && isAiraRiskyCommand(subject)) {
			return ask("process:risk-marker");
		}
		switch (mode) {
			case "normal":
			case "permissive":
			case "yolo":
				return allow("process:routine");
			case "strict":
				return deny("process");
		}
	}
	// network + unknown
	switch (mode) {
		case "normal":
			return ask(capability);
		case "permissive":
		case "yolo":
			return allow(capability);
		case "strict":
			return deny(capability);
	}
}

function defaultReason(tool: string, outcome: string, category: string): string {
	return `${tool}: ${outcome} by permission default (${category})`;
}

/** Normalize a subject for preview (bounded, safe). */
export function previewSubject(subject: string): string {
	const trimmed = subject.trim();
	if (trimmed.length <= 80) {
		return trimmed;
	}
	return `${trimmed.slice(0, 79)}…`;
}

/** Resolve a tool-relative path against a base directory. */
export function resolvePermissionPathSubject(path: string, cwd: string): string {
	if (isAbsolute(path)) {
		return normalize(path);
	}
	return resolve(cwd, path);
}

/** True when `subject` (an absolute path) is inside `root` (also absolute). */
export function isPathWithin(subject: string, root: string): boolean {
	const rel = relative(root, subject);
	return rel === "" || (!rel.startsWith("..") && !isAbsolutePath(rel));
}

function isAbsolutePath(value: string): boolean {
	return isAbsolute(value);
}

/** Normalize + bound a raw persisted rules list (never throws). */
export function normalizeAiraPermissionRules(
	value: unknown,
	scope: AiraPermissionRule["scope"],
	max: number,
): AiraPermissionRule[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const rules: AiraPermissionRule[] = [];
	for (const entry of value) {
		if (rules.length >= max) {
			break;
		}
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const tool = typeof record.tool === "string" ? record.tool.trim() : "";
		const subject = typeof record.subject === "string" ? record.subject.slice(0, 500) : "";
		const action =
			record.action === "allow" || record.action === "ask" || record.action === "deny" ? record.action : undefined;
		const match = record.match === "exact" || record.match === "wildcard" ? record.match : "exact";
		const id = typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 64) : "";
		if (!tool || subject === "" || !action || !id) {
			continue;
		}
		rules.push({
			id,
			tool,
			subject,
			match,
			action,
			scope,
			createdAt:
				typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
					? Math.floor(record.createdAt)
					: Date.now(),
			...(typeof record.note === "string" && record.note.trim() ? { note: record.note.trim().slice(0, 200) } : {}),
		});
	}
	return rules;
}
