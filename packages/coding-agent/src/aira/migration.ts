/**
 * Aira core — optional Pi config import.
 *
 * Aira's canonical home is `~/.aira` and normal operation never reads
 * `~/.pi`. This module makes an existing Pi home importable on request:
 * supported resources are copied from `~/.pi/agent` (or an explicit source)
 * into the Aira agent directory, so a Pi user can carry settings, sessions,
 * extensions, skills, themes, prompts, keybindings, trust, and tools across.
 *
 * Defaults are conservative:
 * - Only known, supported resources are copied; unknown files are ignored.
 * - Credential material (`auth.json`) is excluded unless `includeSecrets`.
 * - A resource already present in the Aira home is never overwritten unless
 *   `overwrite` is set.
 * - `dryRun` reports the plan without touching the filesystem.
 *
 * The Pi source path is read explicitly here (compatibility code may read Pi
 * locations); no production path elsewhere depends on `~/.pi`.
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAiraAgentDir, getAiraHome } from "./paths.ts";

/** Explicit Pi home directory (compatibility/migration only). */
export function getPiHomeDir(): string {
	return join(homedir(), ".pi");
}

/** Explicit Pi agent config directory (`~/.pi/agent`). */
export function getPiAgentDir(): string {
	return join(getPiHomeDir(), "agent");
}

export interface PiImportOptions {
	/** Source agent dir. Default: `~/.pi/agent`. */
	sourceAgentDir?: string;
	/** Target agent dir. Default: the Aira agent dir. */
	targetAgentDir?: string;
	/** Copy credentials (auth.json). Default: false. */
	includeSecrets?: boolean;
	/** Report the plan without copying. Default: false. */
	dryRun?: boolean;
	/** Overwrite existing Aira resources. Default: false. */
	overwrite?: boolean;
}

export type PiImportAction = "copied" | "skipped-existing" | "skipped-secrets" | "dry-run" | "missing";

export interface PiImportResourceResult {
	key: string;
	rel: string;
	action: PiImportAction;
}

export interface PiImportSummary {
	source: string;
	target: string;
	dryRun: boolean;
	includeSecrets: boolean;
	overwrite: boolean;
	resourceCount: number;
	copiedCount: number;
	skippedCount: number;
	resources: PiImportResourceResult[];
	/** Marker file describing the import (`<aira home>/migration.json`). */
	markerPath?: string;
}

interface PiResource {
	key: string;
	rel: string;
	secret: boolean;
}

const PI_RESOURCES: readonly PiResource[] = [
	{ key: "settings", rel: "settings.json", secret: false },
	{ key: "keybindings", rel: "keybindings.json", secret: false },
	{ key: "models", rel: "models.json", secret: false },
	{ key: "modelStore", rel: "models-store.json", secret: false },
	{ key: "trust", rel: "trust.json", secret: false },
	{ key: "auth", rel: "auth.json", secret: true },
	{ key: "themes", rel: "themes", secret: false },
	{ key: "skills", rel: "skills", secret: false },
	{ key: "prompts", rel: "prompts", secret: false },
	{ key: "extensions", rel: "extensions", secret: false },
	{ key: "agents", rel: "agents", secret: false },
	{ key: "tools", rel: "tools", secret: false },
	{ key: "bin", rel: "bin", secret: false },
	{ key: "sessions", rel: "sessions", secret: false },
];

function copyPathRecursive(src: string, dest: string): void {
	const stat = lstatSync(src);
	if (stat.isSymbolicLink()) {
		mkdirSync(dirname(dest), { recursive: true });
		symlinkSync(readlinkSync(src), dest);
		return;
	}
	if (stat.isDirectory()) {
		mkdirSync(dest, { recursive: true });
		for (const entry of readdirSync(src)) {
			copyPathRecursive(join(src, entry), join(dest, entry));
		}
		return;
	}
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	// Preserve executable bits (e.g. managed binaries in bin/).
	chmodSync(dest, stat.mode & 0o777);
}

/** Whether `~/.pi/agent` (or an explicit source) holds at least one importable resource. */
export function hasImportablePiHome(sourceAgentDir: string = getPiAgentDir()): boolean {
	const source = resolve(sourceAgentDir);
	if (!existsSync(source)) return false;
	return PI_RESOURCES.some((resource) => existsSync(join(source, resource.rel)));
}

/** Copy supported Pi home resources into the Aira home. */
export function importPiAgentDir(options: PiImportOptions = {}): PiImportSummary {
	const source = resolve(options.sourceAgentDir ?? getPiAgentDir());
	const target = resolve(options.targetAgentDir ?? getAiraAgentDir());
	const includeSecrets = options.includeSecrets ?? false;
	const dryRun = options.dryRun ?? false;
	const overwrite = options.overwrite ?? false;

	if (source === target) {
		throw new Error(`Refusing to import a Pi home into itself: ${source}`);
	}

	const resources: PiImportResourceResult[] = [];
	let copiedCount = 0;
	let skippedCount = 0;

	for (const resource of PI_RESOURCES) {
		const srcPath = join(source, resource.rel);
		if (!existsSync(srcPath)) {
			resources.push({ key: resource.key, rel: resource.rel, action: "missing" });
			continue;
		}
		if (resource.secret && !includeSecrets) {
			resources.push({ key: resource.key, rel: resource.rel, action: "skipped-secrets" });
			skippedCount++;
			continue;
		}

		const destPath = join(target, resource.rel);
		if (existsSync(destPath) && !overwrite) {
			resources.push({ key: resource.key, rel: resource.rel, action: "skipped-existing" });
			skippedCount++;
			continue;
		}

		if (dryRun) {
			resources.push({ key: resource.key, rel: resource.rel, action: "dry-run" });
			continue;
		}

		if (overwrite && existsSync(destPath)) {
			rmSync(destPath, { recursive: true, force: true });
		}
		copyPathRecursive(srcPath, destPath);
		resources.push({ key: resource.key, rel: resource.rel, action: "copied" });
		copiedCount++;
	}

	let markerPath: string | undefined;
	if (!dryRun && copiedCount > 0) {
		markerPath = join(getAiraHome(), "migration.json");
		mkdirSync(getAiraHome(), { recursive: true });
		writeFileSync(
			markerPath,
			`${JSON.stringify(
				{
					schemaVersion: 1,
					source,
					target,
					importedAt: new Date().toISOString(),
					includeSecrets,
					overwrite,
					resources: resources
						.filter((entry) => entry.action === "copied")
						.map((entry) => ({ key: entry.key, rel: entry.rel })),
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
	}

	return {
		source,
		target,
		dryRun,
		includeSecrets,
		overwrite,
		resourceCount: resources.length,
		copiedCount,
		skippedCount,
		resources,
		markerPath,
	};
}
