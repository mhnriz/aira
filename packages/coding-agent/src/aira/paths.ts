/**
 * Aira core — canonical Aira home path helpers.
 *
 * Every Aira-owned filesystem location resolves through these helpers so no
 * `~/.aira` literal is scattered through the codebase. The Pi-derived host
 * already centralizes its own resource paths in `config.ts` (all under
 * `~/{CONFIG_DIR_NAME}/agent/`); this module is the Aira-facing facade for
 * those paths plus the Aira-only locations (`getAiraCacheDir`,
 * `getAiraAgentsDir`, project-local `.aira/`).
 *
 * Layout (Pi-compatible internal shape preserved):
 *
 * ```text
 * ~/.aira/                      canonical home root (AIRA_HOME_DIR_NAME)
 * └── agent/                    Pi-compatible agent/config root
 *     ├── settings.json         global settings
 *     ├── auth.json             credentials (secrets)
 *     ├── models.json           model configuration
 *     ├── models-store.json     persisted model/catalog cache
 *     ├── keybindings.json      custom keybindings
 *     ├── trust.json            project trust decisions
 *     ├── themes/               custom themes
 *     ├── skills/               user-level skills
 *     ├── prompts/              user-level prompt templates
 *     ├── extensions/           user-level extensions
 *     ├── agents/               user-level subagent prompts
 *     ├── tools/                custom tools
 *     ├── bin/                  managed binaries (fd, rg)
 *     ├── sessions/             session files (encoded by cwd)
 *     ├── cache/                Aira caches (future; model catalogs currently
 *     │                         persist at agent/models-store.json)
 *     └── <app>-debug.log       debug log (aira-debug.log)
 * ```
 *
 * Compatibility: home-level resources moved from `~/.pi/agent` to
 * `~/.aira/agent`; project-local resources moved from `<cwd>/.pi` to
 * `<cwd>/.aira`. The optional Pi import (see `migration.ts`) copies supported
 * resources so normal operation never depends on `~/.pi`.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getAuthPath,
	getBinDir,
	getCustomThemesDir,
	getDebugLogPath,
	getModelsPath,
	getPromptsDir,
	getSessionsDir,
	getSettingsPath,
	getToolsDir,
} from "../config.ts";

/** Canonical home root, e.g. `~/.aira`. */
export function getAiraHome(): string {
	return join(homedir(), CONFIG_DIR_NAME);
}

/** Canonical agent/config directory, e.g. `~/.aira/agent`. */
export function getAiraAgentDir(): string {
	return getAgentDir();
}

/** Project-local Aira config directory for `cwd`, e.g. `<cwd>/.aira`. */
export function getAiraProjectDir(cwd: string): string {
	return join(resolve(cwd), CONFIG_DIR_NAME);
}

// Global settings.
export function getAiraSettingsPath(): string {
	return getSettingsPath();
}

// Sessions (one folder per encoded cwd under it).
export function getAiraSessionsDir(): string {
	return getSessionsDir();
}

// Model configuration and persisted catalog cache.
export function getAiraModelsPath(): string {
	return getModelsPath();
}

/** Persisted model/catalog store (the "cache" for model data today). */
export function getAiraModelStorePath(): string {
	return join(getAiraAgentDir(), "models-store.json");
}

/** Canonical cache directory for Aira caches. */
export function getAiraCacheDir(): string {
	return join(getAiraAgentDir(), "cache");
}

// User-level resources.
export function getAiraExtensionsDir(): string {
	return join(getAiraAgentDir(), "extensions");
}

export function getAiraSkillsDir(): string {
	return join(getAiraAgentDir(), "skills");
}

export function getAiraThemesDir(): string {
	return getCustomThemesDir();
}

export function getAiraPromptsDir(): string {
	return getPromptsDir();
}

/** User-level subagent prompts. */
export function getAiraAgentsDir(): string {
	return join(getAiraAgentDir(), "agents");
}

export function getAiraToolsDir(): string {
	return getToolsDir();
}

export function getAiraBinDir(): string {
	return getBinDir();
}

// Credentials and trust (secrets).
export function getAiraAuthPath(): string {
	return getAuthPath();
}

export function getAiraKeybindingsPath(): string {
	return join(getAiraAgentDir(), "keybindings.json");
}

export function getAiraTrustPath(): string {
	return join(getAiraAgentDir(), "trust.json");
}

// Logs.
export function getAiraDebugLogPath(): string {
	return getDebugLogPath();
}

/** Absolute path rendered as `~/...` when under the home directory. */
export function displayPathUnderHome(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`) || path.startsWith(`${home}${"\\"}`)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * The Phase 2 home resources, keyed for diagnostics, migration, and tests:
 * settings, sessions, cache, extensions, skills, themes, agents, and logs.
 * Computed per call so env-driven home overrides are honored.
 */
export function getAiraHomeResources(): ReadonlyArray<{ key: string; path: string }> {
	return [
		{ key: "settings", path: getAiraSettingsPath() },
		{ key: "sessions", path: getAiraSessionsDir() },
		{ key: "cache", path: getAiraCacheDir() },
		{ key: "models", path: getAiraModelsPath() },
		{ key: "modelStore", path: getAiraModelStorePath() },
		{ key: "extensions", path: getAiraExtensionsDir() },
		{ key: "skills", path: getAiraSkillsDir() },
		{ key: "themes", path: getAiraThemesDir() },
		{ key: "prompts", path: getAiraPromptsDir() },
		{ key: "agents", path: getAiraAgentsDir() },
		{ key: "tools", path: getAiraToolsDir() },
		{ key: "bin", path: getAiraBinDir() },
		{ key: "keybindings", path: getAiraKeybindingsPath() },
		{ key: "trust", path: getAiraTrustPath() },
		{ key: "debugLog", path: getAiraDebugLogPath() },
	];
}
