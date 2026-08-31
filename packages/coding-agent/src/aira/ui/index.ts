/**
 * Aira UI — Workbench projection surface.
 *
 * PURE projection modules only: no TUI imports, no rendering, no
 * interactive-component instantiation. Safe to import from headless/SDK/RPC
 * contexts (rendering Workbench projections consumes zero model tokens).
 * The interactive renderer (sidebar/footer components) lives in
 * `modes/interactive/workbench/` and is never imported here.
 */

export * from "./finding.ts";
export * from "./footer.ts";
export * from "./panels.ts";
export * from "./projection.ts";
export * from "./types.ts";
export * from "./visibility.ts";
