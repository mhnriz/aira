/**
 * Aira core — public surface of the native Aira subsystem.
 *
 * Host integration points should import from here (or from the two modules
 * below directly). Everything in `src/aira/` is Aira-owned; everything else in
 * the package is Pi-derived.
 */

export * from "./commands/doctor.ts";
export * from "./commands/import.ts";
export * from "./commands/mode.ts";
export * from "./commands/status.ts";
export * from "./intelligence/index.ts";
export * from "./lifecycle.ts";
export * from "./meta.ts";
export * from "./migration.ts";
export * from "./modes.ts";
export * from "./paths.ts";
export * from "./project/index.ts";
export * from "./state.ts";
