/**
 * Aira execution — public surface of the native execution runtime.
 *
 * The runtime is a per-session process/service owner (Phase 6). Host and
 * model surfaces import from here: the process manager (`manager`), the
 * project-aware command runner (`project-commands`), and the model-facing
 * tools (`tools`).
 */

export * from "./buffer.ts";
export * from "./manager.ts";
export * from "./platform.ts";
export * from "./project-commands.ts";
export * from "./status.ts";
export * from "./tools.ts";
export * from "./types.ts";
