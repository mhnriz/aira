/**
 * Aira project — project profile shape.
 *
 * A `ProjectProfile` is the canonical description of the workspace Aira is
 * operating in. It lives on `AiraSessionState.project` (ADR-005: one canonical
 * session-state owner), so every mode and future subsystem observes the same
 * project. It is deliberately evidence-based and lightweight: never a repo
 * index, never a semantic model. Roadmap Phase 5+ owns that depth.
 *
 * Scope is a safety boundary. Detection never classifies the user's home
 * directory — or any parent of it — as one giant project; it prefers the
 * nearest defensible project root (see detect.ts).
 */
import { basename } from "node:path";

export type AiraProjectConfidence = "none" | "low" | "medium" | "high";

export interface AiraProjectProfile {
	/** Absolute path to the detected project root, or undefined when no project. */
	root: string | undefined;
	/** Git signals for the project. */
	git: {
		/** True when the root carries a `.git` marker (dir or worktree file). */
		hasGit: boolean;
		/** Absolute git root, when a marker was found. Usually equals `root`. */
		root: string | undefined;
	};
	/** Distinct programming languages evidenced by manifests/signals. */
	languages: readonly string[];
	/** Recognized application frameworks evidenced by manifests. */
	frameworks: readonly string[];
	/** Recognized package managers evidenced by lockfiles/manifests. */
	packageManagers: readonly string[];
	/** Conventional test commands for the detected toolchain. */
	testCommands: readonly string[];
	/** Conventional build commands for the detected toolchain. */
	buildCommands: readonly string[];
	/** Conventional dev/run commands for the detected toolchain. */
	devCommands: readonly string[];
	/** True when the project plausibly runs a browser-testable web app. */
	browserRelevant: boolean;
	/** Deployment/CI signals (docker, CI configs, serverless, hosts). */
	deploymentHints: readonly string[];
	/** How strong the evidence is. Reflects evidence, not certainty. */
	confidence: AiraProjectConfidence;
}

/** Canonical "no project" profile returned when no defensible root is found. */
export const NO_AIRA_PROJECT: AiraProjectProfile = {
	root: undefined,
	git: { hasGit: false, root: undefined },
	languages: [],
	frameworks: [],
	packageManagers: [],
	testCommands: [],
	buildCommands: [],
	devCommands: [],
	browserRelevant: false,
	deploymentHints: [],
	confidence: "none",
};

/**
 * A short, human-readable summary of a project for /status and /doctor.
 * Restrained: root basename, languages, confidence — not the whole profile.
 *
 * Examples: `"none"`, `"myproj (node, python) [high]"`.
 */
export function summarizeAiraProject(profile: AiraProjectProfile | undefined): string {
	if (!profile || !profile.root) {
		return "none";
	}
	const root = basename(profile.root);
	const langs = profile.languages.length === 0 ? [] : [` (${profile.languages.join(", ")})`];
	return `${profile.root === profile.git.root ? root : root}${langs.join("")} [${profile.confidence}]`;
}
