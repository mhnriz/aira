/**
 * Aira browser — ambient eligibility.
 *
 * Availability, eligibility, activation and context injection are distinct
 * concepts (a Phase 5 lesson, applied):
 *
 * - AVAILABLE: a browser executable can be resolved;
 * - ELIGIBLE:   the current project/task could benefit from browser checks;
 * - ACTIVE:     Aira owns a running browser session;
 * - INJECTED:   browser evidence actually enters a prompt (context.ts).
 *
 * Eligibility is evidence-based and conservative. Merely containing frontend
 * code never triggers anything: Aira does not launch a browser only because
 * a repository has React. Signals used:
 *
 * - ProjectProfile.browserRelevant;
 * - a browser-relevant file changed recently (frontend sources);
 * - a Phase 6 dev process is running with a known local URL;
 * - the active interaction mode (BUILD/REVIEW favor checks);
 * - an explicit browser operation by the user/model.
 */
import type { AiraMode, AiraSessionState } from "../state.ts";

/** File extensions that make an edit browser-relevant (frontend surface). */
const FRONTEND_EXTENSIONS = new Set([
	".tsx",
	".jsx",
	".vue",
	".svelte",
	".html",
	".htm",
	".css",
	".scss",
	".sass",
	".less",
]);

/** Route/page directory markers (routes/, pages/, app/ under src). */
const ROUTE_PATH_MARKERS = ["/routes/", "/pages/", "/app/", "/views/", "/components/"];

export interface AiraBrowserEligibilityInput {
	project: AiraSessionState["project"];
	mode: AiraMode;
	/** True when a Phase 6 dev process is running. */
	devRunning: boolean;
	/** Known local URL from dev-process evidence. */
	localUrl?: string;
	/** Path of the most recent completed edit (relative to session cwd). */
	lastEditPath?: string;
	/** Explicit browser operation requested in the last prompt/turn. */
	explicitRequest?: boolean;
}

export interface AiraBrowserEligibility {
	eligible: boolean;
	/** Truthful reason ("project is not browser-relevant", "dev server running", ...). */
	reason: string;
	/** True when the current change set is browser-relevant (autoVerify gate). */
	changeRelevant: boolean;
}

/** Is a workspace path browser-relevant (frontend surface)? */
export function isBrowserRelevantPath(path: string): boolean {
	const lower = path.toLowerCase();
	const extension = extensionOf(lower);
	if (extension && FRONTEND_EXTENSIONS.has(extension)) return true;
	return ROUTE_PATH_MARKERS.some((marker) => lower.includes(marker));
}

/** Decide ambient browser eligibility for a session. */
export function decideBrowserEligibility(input: AiraBrowserEligibilityInput): AiraBrowserEligibility {
	const profile = input.project;
	if (!profile?.root || profile.confidence === "none") {
		return { eligible: false, reason: "no defensible project", changeRelevant: false };
	}
	const changeRelevant = input.lastEditPath !== undefined && isBrowserRelevantPath(input.lastEditPath);
	const devReady = input.devRunning && Boolean(input.localUrl);
	const explicit = input.explicitRequest === true;

	if (!profile.browserRelevant) {
		// Explicit browser work still works; ambient eligibility stays off.
		return {
			eligible: explicit,
			reason: explicit ? "explicit browser request" : "project profile is not browser-relevant",
			changeRelevant,
		};
	}
	if (explicit) {
		return { eligible: true, reason: "explicit browser request", changeRelevant };
	}
	// Conservation rule: docs/backend-only work never becomes browser-eligible
	// just because the repository contains frontend code.
	const signal = changeRelevant || devReady;
	if (!signal) {
		return {
			eligible: false,
			reason: "no browser-relevant change or running dev server",
			changeRelevant,
		};
	}
	if (input.mode === "plan") {
		// PLAN keeps browser observation reachable (already-open sessions);
		// eligibility drives ambient context/autoVerify, which stay off here.
		return { eligible: false, reason: "PLAN mode: ambient browser checks off", changeRelevant };
	}
	if (devReady) {
		return { eligible: true, reason: `dev server running at ${input.localUrl}`, changeRelevant };
	}
	return { eligible: true, reason: "browser-relevant change", changeRelevant };
}

function extensionOf(path: string): string | undefined {
	const index = path.lastIndexOf(".");
	if (index <= 0 || index === path.length - 1) return undefined;
	return path.slice(index);
}
