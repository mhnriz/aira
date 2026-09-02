/**
 * Aira permissions — per-session controller.
 *
 * The session-side authorization surface. `gate()` is called by the host
 * tool boundary (`AgentSession.beforeToolCall`) AFTER the PLAN read-only
 * check; it runs the deterministic pipeline (policy.ts), and when the
 * outcome is ASK it opens the shared native interaction (kind
 * "permission") and maps the user's decision:
 *
 *   allow once   → the exact tool+subject is allowed this one time
 *   allow session→ a session-scoped EXACT rule is recorded (no broadening)
 *   allow always → a persistent EXACT rule is written to the Aira-owned
 *                  store (no broadening)
 *   deny / cancel→ truthful denial returned to the tool call
 *   unavailable  → truthful denial (no interactive UI to ask with)
 *
 * The controller never grants anything beyond its match: approvals are
 * exact-subject only, and project-controlled configuration is never read.
 */
import { randomUUID } from "node:crypto";
import { classifyAiraBrowserOperation, classifyAiraCapability } from "../capabilities.ts";
import type { AiraInteractionHandle } from "../interaction/manager.ts";
import { isAiraMutatingTool } from "../modes.ts";
import type { AiraSessionState } from "../state.ts";
import { evaluateAiraPermissionRequest, normalizeAiraPermissionMode, resolvePermissionPathSubject } from "./policy.ts";
import { buildAiraPermissionPresentation } from "./presentation.ts";
import { createAiraPermissionRuleStore } from "./rules-store.ts";
import {
	AIRA_PERMISSION_MAX_SESSION_RULES,
	type AiraPermissionEvaluation,
	type AiraPermissionMode,
	type AiraPermissionRequest,
	type AiraPermissionRule,
	type AiraPermissionStatus,
} from "./types.ts";

export interface AiraPermissionSettings {
	/** Whether the ask/enforce pipeline is active (false disables prompting). */
	enabled: boolean;
	/** The permission mode (normal | permissive | strict | yolo). */
	mode: AiraPermissionMode;
}

export interface AiraPermissionControllerOptions {
	/** Session working directory. */
	cwd: string;
	/** Canonical project root (mutating scope boundary; undefined = cwd). */
	projectRoot?: () => string | undefined;
	/** Canonical settings accessor (live). */
	settings: () => AiraPermissionSettings;
	/** The shared native interaction manager (kind "permission"). */
	interaction: AiraInteractionHandle;
	/** Persistent rule store (Aira-owned config); defaults to the canonical store. */
	store?: {
		load(): { rules: AiraPermissionRule[]; health: AiraPermissionStatus["store"] };
		save(rules: readonly AiraPermissionRule[]): AiraPermissionStatus["store"];
	};
	/** For test isolation: an explicit current-mode override + clock. */
	modeSeam?: () => AiraPermissionMode | undefined;
	now?: () => number;
}

export interface AiraPermissionControllerHandle {
	/**
	 * Gate one tool call. Returns `{ block, reason }` — block=true means the
	 * tool must not execute and the reason is the truthful tool denial.
	 */
	gate(toolName: string, args: Record<string, unknown>): Promise<{ block: boolean; reason?: string }>;
	/**
	 * Deterministic child gate (no prompting): children resolve ASK as DENY
	 * with a truthful reason. Never blocks on UI; recursion-safe by design.
	 */
	gateForChild(toolName: string, args: Record<string, unknown>): { block: boolean; reason?: string };
	/** Add a rule (used by /permissions rule add). */
	addRule(
		rule: Omit<AiraPermissionRule, "id" | "scope" | "createdAt">,
		scope: "session" | "persistent",
	): {
		ok: boolean;
		message: string;
	};
	/** Remove a persistent rule by id. */
	removeRule(ruleId: string): { ok: boolean; message: string };
	/** Set the permission mode (canonical /permissions mode). */
	setMode(mode: AiraPermissionMode): AiraPermissionMode;
	/** Session rules + persistent rules (for /permissions list). */
	rules(): { session: AiraPermissionRule[]; persistent: AiraPermissionRule[] };
	/** Canonical snapshot (token-free). */
	status(): AiraPermissionStatus;
	subscribe(listener: (status: AiraPermissionStatus) => void): () => void;
	dispose(): void;
}

const MAX_SUBJECT_CHARS = 1024;

export class AiraPermissionController implements AiraPermissionControllerHandle {
	private readonly state: AiraSessionState;
	private readonly options: AiraPermissionControllerOptions;
	private readonly store: NonNullable<AiraPermissionControllerOptions["store"]>;
	private sessionRules: AiraPermissionRule[] = [];
	private onceApprovalsGranted = 0;
	private persistentRules: AiraPermissionRule[] = [];
	private storeHealth: AiraPermissionStatus["store"];
	private lastDecision: AiraPermissionStatus["lastDecision"];
	private readonly listeners = new Set<(status: AiraPermissionStatus) => void>();
	private snapshot: AiraPermissionStatus;
	private disposed = false;

	constructor(state: AiraSessionState, options: AiraPermissionControllerOptions) {
		this.state = state;
		this.options = options;
		const store = options.store ?? createAiraPermissionRuleStore();
		const loaded = store.load();
		this.store = store;
		this.persistentRules = loaded.rules;
		this.storeHealth = loaded.health;
		this.lastDecision = undefined;
		this.snapshot = this.buildSnapshot();
	}

	activate(): void {
		if (this.disposed) {
			return;
		}
		this.publish();
	}

	async gate(toolName: string, args: Record<string, unknown>): Promise<{ block: boolean; reason?: string }> {
		if (this.disposed) {
			return { block: true, reason: "permission controller disposed" };
		}
		const settings = this.options.settings();
		const mode = this.options.modeSeam?.() ?? settings.mode;

		// PLAN remains the host's absolute read-only boundary; the beforeToolCall
		// PLAN check runs first, this is defense in depth for parity.
		if (this.state.mode === "plan" && isAiraMutatingTool(toolName)) {
			return {
				block: true,
				reason: `PLAN mode is read-only: ${toolName} is blocked (permissions cannot override PLAN)`,
			};
		}

		const request = this.buildRequest(toolName, args);

		const evaluation = settings.enabled
			? evaluateAiraPermissionRequest(request, {
					mode,
					rules: [...this.persistentRules, ...this.sessionRules],
					plan: false,
					projectRoot: this.projectRoot(),
				})
			: ({ action: "allow", reason: "permission enforcement disabled" } satisfies AiraPermissionEvaluation);

		if (evaluation.action === "allow") {
			this.recordDecision(request.tool, "allow", request.subject);
			return { block: false };
		}
		if (evaluation.action === "deny") {
			this.recordDecision(request.tool, "deny", request.subject);
			return { block: true, reason: denialReason(toolName, evaluation) };
		}

		// ASK → the shared native interaction (kind "permission").
		const answer = await this.options.interaction.ask(
			{
				type: "permission",
				question: `Allow ${toolName} to run?`,
				context: permissionContext(request),
				choices: [
					{ id: "allow-once", label: "Allow once", description: "Run only this request" },
					{
						id: "allow-session",
						label: "Allow session",
						description: "Approve this exact subject for this session",
					},
					{
						id: "allow-always",
						label: "Allow always",
						description: "Persist approval for this exact subject",
					},
					{ id: "deny", label: "Deny", description: "Do not execute" },
				],
				freeform: false,
				owner: `permission:${toolName}`,
				// Deterministic card data: bounded, redacted, UI-only projection of the
				// canonical request + evaluation. Never policy input, never model context.
				permission: buildAiraPermissionPresentation({
					tool: request.tool,
					capability: request.capability,
					browserOperation: request.browserOperation,
					subject: request.subject,
					args,
					evaluation,
					cwd: this.options.cwd,
					projectRoot: this.projectRoot(),
				}),
			},
			undefined,
		);

		if (answer.resolution !== "answered" || !answer.decision) {
			// Cancelled / timed-out / unavailable / superseded → truthful denial.
			this.recordDecision(request.tool, "deny", request.subject);
			return {
				block: true,
				reason: `${denialReason(toolName, evaluation)} (permission prompt ${answer.resolution}; treated as denied — no answer was given)`,
			};
		}
		switch (answer.decision) {
			case "allow-once":
				// Grants THIS exact request only; nothing is stored or
				// broadened. The next equivalent request asks again.
				this.onceApprovalsGranted += 1;
				this.recordDecision(request.tool, "allow", request.subject);
				return { block: false };
			case "allow-session":
				this.addSessionRule(request.tool, request.subject ?? toolName);
				this.recordDecision(request.tool, "allow", request.subject);
				return { block: false };
			case "allow-always":
				this.addPersistentRule(request.tool, request.subject ?? toolName);
				this.recordDecision(request.tool, "allow", request.subject);
				return { block: false };
			default:
				this.recordDecision(request.tool, "deny", request.subject);
				return { block: true, reason: `${denialReason(toolName, evaluation)} (denied by the user)` };
		}
	}

	gateForChild(toolName: string, args: Record<string, unknown>): { block: boolean; reason?: string } {
		if (this.disposed) {
			return { block: true, reason: "permission controller disposed" };
		}
		const settings = this.options.settings();
		const mode = this.options.modeSeam?.() ?? settings.mode;
		// PLAN is absolute for children too (the orchestration mode gate already
		// refuses mutation-capable roles; this mirrors it for process tools).
		if (this.state.mode === "plan" && isAiraMutatingTool(toolName)) {
			return {
				block: true,
				reason: `PLAN mode is read-only: ${toolName} is blocked (permissions cannot override PLAN)`,
			};
		}
		const request = this.buildRequest(toolName, args);
		const evaluation = settings.enabled
			? evaluateAiraPermissionRequest(request, {
					mode,
					rules: [...this.persistentRules, ...this.sessionRules],
					plan: false,
					projectRoot: this.projectRoot(),
				})
			: ({ action: "allow", reason: "permission enforcement disabled" } satisfies AiraPermissionEvaluation);
		if (evaluation.action === "allow") {
			return { block: false };
		}
		// Children never prompt (nested interactive storms are impossible):
		// ASK resolves as DENY with a truthful reason — the user can approve
		// at the root or relax the mode.
		return {
			block: true,
			reason:
				evaluation.action === "deny"
					? denialReason(toolName, evaluation)
					: `${denialReason(toolName, evaluation)} — children cannot prompt for permission; approve at the root or switch permission mode`,
		};
	}

	addRule(
		rule: Omit<AiraPermissionRule, "id" | "scope" | "createdAt">,
		scope: "session" | "persistent",
	): { ok: boolean; message: string } {
		const full: AiraPermissionRule = {
			...rule,
			id: `r-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
			scope,
			createdAt: this.now(),
		};
		if (scope === "session") {
			if (this.sessionRules.length >= AIRA_PERMISSION_MAX_SESSION_RULES) {
				return { ok: false, message: `session rule limit reached (${AIRA_PERMISSION_MAX_SESSION_RULES})` };
			}
			this.sessionRules.push(full);
			this.publish();
			return { ok: true, message: `session rule added: ${full.tool} ${full.subject} ${full.action}` };
		}
		if (this.persistentRules.length >= 128) {
			return { ok: false, message: "persistent rule limit reached (128)" };
		}
		this.persistentRules.push(full);
		this.persistPersistentRules();
		this.publish();
		return { ok: true, message: `persistent rule added: ${full.tool} ${full.subject} ${full.action}` };
	}

	removeRule(ruleId: string): { ok: boolean; message: string } {
		const before = this.persistentRules.length;
		this.persistentRules = this.persistentRules.filter((rule) => rule.id !== ruleId);
		if (this.persistentRules.length === before) {
			return { ok: false, message: `no persistent rule with id "${ruleId}"` };
		}
		this.persistPersistentRules();
		this.publish();
		return { ok: true, message: `persistent rule ${ruleId} removed` };
	}

	setMode(mode: AiraPermissionMode): AiraPermissionMode {
		this.options.modeSeam?.(); // reserved: canonical settings write happens host-side
		this.publish();
		return mode;
	}

	rules(): { session: AiraPermissionRule[]; persistent: AiraPermissionRule[] } {
		return {
			session: this.sessionRules.map((rule) => ({ ...rule })),
			persistent: this.persistentRules.map((rule) => ({ ...rule })),
		};
	}

	status(): AiraPermissionStatus {
		this.publish();
		return this.snapshot;
	}

	subscribe(listener: (status: AiraPermissionStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.listeners.clear();
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	private buildRequest(toolName: string, args: Record<string, unknown>): AiraPermissionRequest {
		const capability = classifyAiraCapability(toolName);
		const request: AiraPermissionRequest = {
			tool: toolName,
			capability,
			...(capability === "browser" ? { browserOperation: classifyAiraBrowserOperation(toolName) } : {}),
		};
		const subject = subjectOf(toolName, args, this.options.cwd);
		if (subject !== undefined) {
			request.subject = subject.slice(0, MAX_SUBJECT_CHARS);
		} else {
			request.subject = toolName;
		}
		return request;
	}

	private projectRoot(): string | undefined {
		return this.options.projectRoot?.() ?? this.state.project?.root ?? this.options.cwd;
	}

	private addSessionRule(tool: string, subject: string): void {
		this.sessionRules.push({
			id: `s-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
			tool,
			subject: exactSubject(subject),
			match: "exact",
			action: "allow",
			scope: "session",
			createdAt: this.now(),
			note: "approved via permission dialog (session)",
		});
		if (this.sessionRules.length > AIRA_PERMISSION_MAX_SESSION_RULES) {
			this.sessionRules.shift();
		}
		this.publish();
	}

	private addPersistentRule(tool: string, subject: string): void {
		this.persistentRules.push({
			id: `p-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
			tool,
			subject: exactSubject(subject),
			match: "exact",
			action: "allow",
			scope: "persistent",
			createdAt: this.now(),
			note: "approved via permission dialog (persistent)",
		});
		if (this.persistentRules.length > 128) {
			this.persistentRules.shift();
		}
		this.persistPersistentRules();
		this.publish();
	}

	private persistPersistentRules(): void {
		this.storeHealth = this.store.save(this.persistentRules);
		if (this.storeHealth.status === "failed") {
			// The in-memory rule still applies this session; persistence failed
			// truthfully without breaking the session.
			this.persistentRules = this.persistentRules.slice(0, 128);
		}
	}

	private recordDecision(
		tool: string,
		action: Exclude<AiraPermissionStatus["lastDecision"], undefined>["action"],
		subject?: string,
	): void {
		this.lastDecision = {
			tool,
			action,
			at: this.now(),
			...(subject ? { subject: subject.slice(0, 80) } : {}),
		};
		this.publish();
	}

	private buildSnapshot(): AiraPermissionStatus {
		const settings = this.options.settings();
		return {
			enabled: settings.enabled,
			mode: this.options.modeSeam?.() ?? settings.mode,
			persistentRules: this.persistentRules.length,
			sessionRules: this.sessionRules.length,
			onceApprovals: this.onceApprovalsGranted,
			store: this.storeHealth,
			lastDecision: this.lastDecision,
			updatedAt: this.now(),
			summary: permissionSummary(
				settings,
				this.persistentRules.length,
				this.sessionRules.length,
				this.onceApprovalsGranted,
			),
		};
	}

	private publish(): void {
		this.snapshot = this.buildSnapshot();
		this.state.permissions = this.snapshot;
		for (const listener of [...this.listeners]) {
			listener(this.snapshot);
		}
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

/** Subject for rule storage: never a wildcard-expandable string (exact match). */
function exactSubject(subject: string): string {
	return subject.trim();
}

/** Derive the deterministic matching subject from tool args. */
function subjectOf(toolName: string, args: Record<string, unknown>, cwd: string): string | undefined {
	const readString = (key: string): string | undefined => (typeof args?.[key] === "string" ? args[key] : undefined);
	switch (toolName) {
		case "bash":
		case "powershell":
			return readString("command");
		case "process_start":
		case "process_stop": {
			const command = readString("command");
			if (command) {
				return command;
			}
			const exe = readString("exe");
			if (exe) {
				const argList = Array.isArray(args?.args)
					? args.args.filter((item): item is string => typeof item === "string")
					: [];
				return [exe, ...argList].join(" ");
			}
			return undefined;
		}
		case "edit":
		case "write":
		case "read": {
			const path = readString("path");
			if (!path) {
				return undefined;
			}
			return resolvePermissionPathSubject(path, cwd);
		}
		default:
			return undefined;
	}
}

function permissionContext(request: AiraPermissionRequest): string {
	const subject = request.subject ?? request.tool;
	const kind =
		request.capability === "process" ? "command" : request.capability === "mutating" ? "path" : request.capability;
	return `${request.tool} · ${kind}: ${subject.slice(0, 400)}`;
}

function denialReason(toolName: string, evaluation: AiraPermissionEvaluation): string {
	return `${toolName}: permission denied — ${evaluation.reason}`;
}

function permissionSummary(
	settings: AiraPermissionSettings,
	persistent: number,
	session: number,
	once: number,
): string {
	if (!settings.enabled) {
		return "disabled";
	}
	const parts: string[] = [settings.mode];
	if (persistent > 0) {
		parts.push(`${persistent} persistent rule(s)`);
	}
	if (session > 0) {
		parts.push(`${session} session approval(s)`);
	}
	if (once > 0) {
		parts.push(`${once} one-time approval(s)`);
	}
	return parts.join(" · ");
}

/** Create the session's permission controller and return the handle. */
export function createAiraPermissionController(
	state: AiraSessionState,
	options: AiraPermissionControllerOptions,
): AiraPermissionControllerHandle {
	const controller = new AiraPermissionController(state, options);
	controller.activate();
	return controller;
}

export { normalizeAiraPermissionMode };
