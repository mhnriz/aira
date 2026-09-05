/** Deterministic audit of text injected into model context. */

export type AiraContextCostActivation = "always" | "mode" | "task" | "child" | "ui-only" | "host-only";

export interface AiraContextCostSection {
	id: string;
	activation: AiraContextCostActivation;
	chars: number;
	estimatedTokens: number;
}

/** A conservative local estimate used when provider tokenization is unavailable. */
export function estimateAiraTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function measureAiraContextSection(
	id: string,
	activation: AiraContextCostActivation,
	text: string,
): AiraContextCostSection {
	// UI projections may have rendered characters, but they are not sent to a
	// provider. Keep their provider cost explicitly zero so the audit cannot
	// accidentally turn a human-visible row into model context.
	if (activation === "ui-only" || activation === "host-only") {
		return { id, activation, chars: 0, estimatedTokens: 0 };
	}
	return { id, activation, chars: text.length, estimatedTokens: estimateAiraTextTokens(text) };
}

/** Build a stable report from the exact strings a caller injects. */
export function buildAiraContextCostAudit(
	sections: readonly { id: string; activation: AiraContextCostActivation; text: string }[],
): AiraContextCostSection[] {
	return sections.map((section) => measureAiraContextSection(section.id, section.activation, section.text));
}
