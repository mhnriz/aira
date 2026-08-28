/**
 * Aira browser — CDP provider public surface.
 *
 * The native provider implementation sits entirely behind the
 * `AiraBrowserProvider` boundary (provider.ts): Aira never sees raw CDP
 * handles. This module exposes the provider factory and the small pure
 * helpers (launch/session/observe/interact/buffers) for tests.
 */

export * from "./client.ts";
export * from "./console.ts";
export * from "./interact.ts";
export * from "./launch.ts";
export * from "./network.ts";
export * from "./observe.ts";
export * from "./provider.ts";
export * from "./session.ts";
