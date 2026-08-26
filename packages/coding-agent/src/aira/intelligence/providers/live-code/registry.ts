/**
 * Aira intelligence — language-server registry and discovery.
 *
 * The foundational live-code provider serves the core compiled/scripted
 * languages with mature, PATH-installable servers. Discovery checks the
 * process PATH first, then the project's own `node_modules/.bin` (typescript-
 * language-server commonly lives there). A server that is not installed is
 * simply "not available" — the provider degrades, never breaks Aira
 * (ADR-009: specialist engines stay replaceable; missing tools must not
 * block the harness).
 *
 * Deliberately small: no managed installs, no per-server downloaders, no
 * version negotiation. Later phases can grow the registry behind this same
 * shape. Language ids follow the LSP conventions the servers themselves use.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LspServerDefinition {
	/** Provider id used in findings and health. */
	id: string;
	/** LSP language ids this server serves. */
	languageIds: string[];
	/** Candidate launch commands with arguments; the first found wins. */
	commands: string[][];
}

/** The foundational server registry (Babel-less, lazy: only consulted on demand). */
export const LIVE_CODE_SERVER_DEFINITIONS: readonly LspServerDefinition[] = [
	{
		id: "typescript",
		languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
		commands: [["typescript-language-server", "--stdio"]],
	},
	{
		id: "python",
		languageIds: ["python"],
		commands: [
			["pyright-langserver", "--stdio"],
			["basedpyright-langserver", "--stdio"],
		],
	},
	{
		id: "go",
		languageIds: ["go"],
		commands: [["gopls"]],
	},
	{
		id: "rust",
		languageIds: ["rust"],
		commands: [["rust-analyzer"]],
	},
	{
		id: "cpp",
		languageIds: ["cpp", "c"],
		commands: [["clangd"]],
	},
	{
		id: "csharp",
		languageIds: ["csharp"],
		commands: [["omnisharp", "-stdio"]],
	},
];

/** Map a repository language to the LSP language id(s) its server serves. */
export function lspLanguageIds(repositoryLanguage: string): string[] {
	const byRepositoryLanguage = {
		typescript: ["typescript", "typescriptreact"],
		javascript: ["javascript", "javascriptreact"],
		python: ["python"],
		go: ["go"],
		rust: ["rust"],
		c: ["c"],
		cpp: ["cpp"],
		csharp: ["csharp"],
	} satisfies Record<string, string[]>;
	const ids = byRepositoryLanguage[repositoryLanguage as keyof typeof byRepositoryLanguage];
	return ids ?? [];
}

/** Server definition for a repository language, if the registry serves it. */
export function serverForLanguage(repositoryLanguage: string): LspServerDefinition | undefined {
	const languageIds = lspLanguageIds(repositoryLanguage);
	if (languageIds.length === 0) {
		return undefined;
	}
	return LIVE_CODE_SERVER_DEFINITIONS.find((definition) =>
		definition.languageIds.some((id) => languageIds.includes(id)),
	);
}

/** Is a command resolvable on PATH? (Windows: `where`; else `which`.) */
export function commandOnPath(command: string): boolean {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export interface LaunchSpec {
	command: string;
	args: string[];
	argv0: string;
}

/**
 * Resolve the first launchable command for a definition: project-local
 * `node_modules/.bin` first, then PATH.
 */
export function resolveLaunchSpec(
	definition: LspServerDefinition,
	projectRoot: string | undefined,
): LaunchSpec | undefined {
	for (const candidate of definition.commands) {
		const command = candidate[0] ?? "";
		const args = candidate.slice(1);
		const projectBin = projectRoot ? join(projectRoot, "node_modules", ".bin", command) : undefined;
		if (projectBin && existsSync(projectBin)) {
			return { command, args, argv0: projectBin };
		}
		if (commandOnPath(command)) {
			return { command, args, argv0: command };
		}
	}
	return undefined;
}

/** All registry server ids in health-relevant order. */
export function registeredServerIds(): string[] {
	return LIVE_CODE_SERVER_DEFINITIONS.map((definition) => definition.id);
}
