/**
 * Aira intelligence — provider surface.
 *
 * Providers are the replaceable engines behind the intelligence service.
 * Phase 5 ships the two native providers (repository + live-code) behind a
 * thin registration surface so a later phase can swap implementations
 * without touching the coordinator.
 */

export * from "./live-code/index.ts";
export * from "./live-code/lsp-client.ts";
export * from "./live-code/registry.ts";
export * from "./repository/cache.ts";
export * from "./repository/index.ts";
export * from "./repository/relationships.ts";
export * from "./repository/scanner.ts";
