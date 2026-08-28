/**
 * Aira browser — public surface of the native browser subsystem.
 *
 * The Phase 7 native browser runtime: one runtime owner per session
 * (manager), a replaceable provider boundary (provider), a native CDP
 * implementation (cdp/), bounded evidence (types), ambient context
 * (context), local URL discovery (url-discovery), eligibility rules
 * (eligibility), canonical settings (settings), and the model-facing tools
 * (tools).
 *
 * Host integration points import from here. Everything in `src/aira/browser/`
 * is Aira-owned; nothing here requires the reference browser extensions.
 */

export * from "./cdp/index.ts";
export * from "./context.ts";
export * from "./eligibility.ts";
export * from "./manager.ts";
export * from "./provider.ts";
export * from "./settings.ts";
export * from "./status.ts";
export * from "./tools.ts";
export * from "./types.ts";
export * from "./url-discovery.ts";
