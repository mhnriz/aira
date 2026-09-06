import type { LaneRecord } from "./types.ts";

/** Fork handling for durable session state owned by the current Aira model. */
export type ForkStateDisposition = "copy" | "exclude" | "reconstruct";

/**
 * Classifies state before a fork is materialized. Execution records are
 * intentionally excluded: Stage 3/4 effects belong to the source lane and
 * cannot be resumed safely from a copied session without a projection rule.
 */
export function classifyForkState(kind: "entry" | "record" | "lane" | "fact"): ForkStateDisposition {
	switch (kind) {
		case "entry":
		case "fact":
			return "copy";
		case "lane":
			return "reconstruct";
		case "record":
			return "exclude";
	}
}

/** All durable execution records are source-owned and are never fork-copied. */
export function shouldCopyForkRecord(_record: LaneRecord): boolean {
	return classifyForkState("record") === "copy";
}
