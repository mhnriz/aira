/**
 * Aira browser — ambient model context.
 *
 * A running browser does NOT mean browser evidence belongs in every prompt.
 * This module builds the compact browser pack and applies the hard rules:
 *
 * - off:   never injected (explicit operations still return their results;
 *          state stays visible through the canonical snapshot);
 * - auto:  injected only when state SIGNALS relevance: browser-relevant
 *          change, verification result change, new console/network finding,
 *          or active-tab change since the last injection. Commonly zero
 *          tokens (a README edit, a backend-only change, git work: nothing);
 * - on:    injected whenever a browser session is active and fresh evidence
 *          exists, still bounded and deduplicated.
 *
 * Budgets are hard character caps per size class; identical unchanged
 * content is never re-injected (the manager hashes it).
 */
import { createHash } from "node:crypto";
import type { AiraBrowserContextBudget, AiraBrowserContextSetting } from "./settings.ts";
import type { AiraBrowserStatus } from "./status.ts";

export interface AiraBrowserContextInput {
	settings: {
		context: AiraBrowserContextSetting;
		budget: AiraBrowserContextBudget;
	};
	status: AiraBrowserStatus;
	/** True when a browser-relevant change happened since the last injection. */
	relevanceSignal: boolean;
	/** Count of browser-relevant edits not yet reflected in injected context. */
	pendingEdits: number;
}

export interface AiraBrowserContextResult {
	content: string | undefined;
	/** Hash of the produced content (dedupe cursor). */
	hash?: string;
}

const BUDGETS: Record<AiraBrowserContextBudget, number> = {
	compact: 600,
	balanced: 1200,
	expanded: 2400,
};

/** Build the bounded browser pack for a prompt (pure; the manager gates it). */
export function buildBrowserContext(input: AiraBrowserContextInput): AiraBrowserContextResult {
	const settings = input.settings;
	if (settings.context === "off") {
		return { content: undefined };
	}
	const status = input.status;
	if (status.status !== "active" && status.status !== "degraded") {
		return { content: undefined };
	}
	const active = status.tabs[0];
	if (!active) {
		// Browser open but no tab state: nothing useful to inject.
		return { content: undefined };
	}

	if (settings.context === "auto" && !input.relevanceSignal && input.pendingEdits === 0) {
		return { content: undefined };
	}

	const budget = BUDGETS[settings.budget];
	const lines: string[] = [];
	let used = 0;
	const push = (line: string): boolean => {
		const cost = line.length + 1;
		if (used + cost > budget) {
			return false;
		}
		lines.push(line);
		used += cost;
		return true;
	};

	const summary = status.observation.summary ? ` · ${status.observation.summary}` : "";
	push(`${active.url || "(blank)"}${summary}`);

	if (status.verification.status !== "none") {
		const lastCheck =
			status.verification.lastCheckAt !== undefined
				? new Date(status.verification.lastCheckAt).toISOString().slice(11, 19)
				: "";
		push(`check: ${status.verification.status}${lastCheck ? ` ${lastCheck}` : ""}`);
		const finding = status.verification.finding;
		if (finding) {
			push(`finding: ${oneLineFinding(finding)}`);
		}
	}

	const consoleCounts = `${status.console.errors} error${status.console.errors === 1 ? "" : "s"}, ${status.console.warnings} warning${status.console.warnings === 1 ? "" : "s"}`;
	if (status.console.errors + status.console.warnings > 0) {
		if (push(`console: ${consoleCounts}`)) {
			const top = status.console.topFinding;
			if (top) {
				push(`  ${oneLineFinding(top)}`);
			}
		}
	} else if (status.console.total > 0) {
		push(`console: ${consoleCounts}`);
	}

	if (status.network.failures > 0) {
		if (push(`network: ${status.network.failures} failed`)) {
			const top = status.network.topFinding;
			if (top) {
				push(`  ${oneLineFinding(top)}`);
			}
		}
	} else {
		push("network: clean");
	}

	const content = lines.join("\n");
	return { content, hash: hashContent(content) };
}

function oneLineFinding(finding: { message: string; source?: string; line?: number }): string {
	const location = finding.source ? ` ${finding.source}${finding.line !== undefined ? `:${finding.line}` : ""}` : "";
	const message = finding.message.length > 160 ? `${finding.message.slice(0, 159)}…` : finding.message;
	return `${message}${location}`;
}

export function hashContent(content: string): string {
	return createHash("sha1").update(content).digest("base64url").slice(0, 16);
}
