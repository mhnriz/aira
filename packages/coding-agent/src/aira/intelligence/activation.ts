/**
 * Aira intelligence — activation decisions.
 *
 * Intelligence is a service, not a tool bag: the harness decides when it
 * activates, driven by the canonical ProjectProfile (ADR-021). Rules:
 *
 * - no defensible project → inactive (no arbitrary-directory indexing);
 * - project with at least one language and any confidence → active;
 * - live-code candidates are the registry-served subset of the project's
 *   languages; nothing is spawned eagerly — activation only arms the
 *   providers, first use stays lazy;
 * - low-confidence bare git repos stay active but are flagged conservative
 *   (the coordinator may skip heavier operations).
 */
import type { AiraProjectConfidence, AiraProjectProfile } from "../project/profile.ts";
import { serverForLanguage } from "./providers/live-code/registry.ts";

export interface IntelligenceActivation {
	active: boolean;
	reason: string;
	languages: readonly string[];
	liveCodeCandidates: readonly string[];
	confidence: AiraProjectConfidence;
}

/** Decide whether Aira intelligence arms for a session. */
export function decideIntelligenceActivation(project: AiraProjectProfile | undefined): IntelligenceActivation {
	if (!project?.root || project.confidence === "none") {
		return {
			active: false,
			reason: "no defensible project (confidence none)",
			languages: project?.languages ?? [],
			liveCodeCandidates: [],
			confidence: project?.confidence ?? "none",
		};
	}
	const languages = [...project.languages];
	const liveCodeCandidates = languages.filter((language) => serverForLanguage(language) !== undefined);
	const conservative = project.confidence === "low";
	return {
		active: true,
		reason: conservative
			? "project detected (low confidence; conservative mode)"
			: `project detected (${project.languages.length} language(s), ${project.confidence})`,
		languages,
		liveCodeCandidates,
		confidence: project.confidence,
	};
}

/** Conservative mode disables heavier operations (post-edit LSP spawns). */
export function isConservativeActivation(activation: IntelligenceActivation): boolean {
	return activation.confidence === "low";
}
