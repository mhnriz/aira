/**
 * Aira project — public surface of the project-awareness subsystem.
 *
 * The host integrates through `resolveAiraProject(cwd)`, which writes the
 * derived `ProjectProfile` into the canonical `AiraSessionState.project`
 * (ADR-005). Detection is evidence-based and bounded; it never becomes a repo
 * index (roadmap Phase 5+) and never treats the home directory as a project.
 */
import type { AiraSessionState } from "../state.ts";
import { type DetectProjectOptions, detectAiraProject } from "./detect.ts";

export { type DetectProjectOptions, detectAiraProject } from "./detect.ts";
export {
	type AiraProjectConfidence,
	type AiraProjectProfile,
	NO_AIRA_PROJECT,
	summarizeAiraProject,
} from "./profile.ts";

/** Detect the project profile for the given cwd (home boundary defaulted). */
export function resolveAiraProject(cwd: string, options?: DetectProjectOptions) {
	return detectAiraProject(cwd, options);
}

/** Set the canonical session state's project from a cwd (narrow host seam). */
export function resolveAiraProjectInto(state: AiraSessionState, cwd: string, options?: DetectProjectOptions): void {
	state.project = detectAiraProject(cwd, options);
}
