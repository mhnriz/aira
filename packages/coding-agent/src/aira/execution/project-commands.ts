/**
 * Aira execution — project-aware commands.
 *
 * Consumes the canonical ProjectProfile (ADR-021) commands — no redetection,
 * no competing project model. Exposes verification primitives with explicit
 * depth semantics:
 *
 * - TARGETED: smallest relevant command — the project test command plus a
 *   toolchain-aware target suffix (npm/pnpm/yarn/bun: `-- <path>`, pytest /
 *   cargo / go: `<path>`, dotnet: `<project>`). Unknown toolchains fall back
 *   to the project command with a note.
 * - RELATED: the same command run at the nearest subpackage with its own
 *   defensible profile (reuses Phase 4 detection for that root). No
 *   subpackage → identical to TARGETED.
 * - PROJECT: the full project command from the profile.
 *
 * `runCheck()` prefers the profile's check commands (Phase 6 small canonical
 * extension) and falls back to build commands. `runDev()` is background by
 * default and reuse-aware (`reuse: "reuse"`).
 *
 * These are execution PRIMITIVES. Orchestration (choose-after-every-edit,
 * repair loops) belongs to later phases; Phase 5 diagnostics remain the
 * cheap immediate feedback path.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { detectAiraProject } from "../project/detect.ts";
import type { AiraProjectProfile } from "../project/profile.ts";
import type { AiraExecutionResult, AiraProcessRequest, AiraStartOptions } from "./types.ts";

export type AiraVerificationDepth = "targeted" | "related" | "project";

export interface AiraProjectRunnerDeps {
	/** The canonical project profile (undefined = no project). */
	profile: AiraProjectProfile | undefined;
	/** Normal working directory (session root) for relative target resolution. */
	cwd: string;
	/** Actual launch (normally the session's execution manager). */
	start: (request: AiraProcessRequest, options?: AiraStartOptions) => Promise<AiraExecutionResult>;
	/** Subpackage profile detection (tests inject; default Phase 4 detection). */
	detectSubproject?: (root: string) => AiraProjectProfile;
}

export interface AiraResolvedCommand {
	command: string;
	cwd: string;
	note?: string;
}

export interface AiraRunOptions {
	/** Verification depth (test runs only). Default: project. */
	depth?: AiraVerificationDepth;
	/** Absolute target path for targeted/related runs. */
	target?: string;
	timeoutMs?: number;
	background?: boolean | "auto";
	/** Dev-process reuse policy (runDev). */
	reuse?: "new" | "reuse" | "restart";
}

const SUBPACKAGE_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt"];

export class AiraProjectCommandRunner {
	private readonly profile: AiraProjectProfile | undefined;
	private readonly cwd: string;
	private readonly start: (request: AiraProcessRequest, options?: AiraStartOptions) => Promise<AiraExecutionResult>;
	private readonly detectSubproject: (root: string) => AiraProjectProfile;
	private readonly exists: (path: string) => boolean;

	constructor(deps: AiraProjectRunnerDeps) {
		this.profile = deps.profile;
		this.cwd = deps.cwd;
		this.start = deps.start;
		this.detectSubproject = deps.detectSubproject ?? detectAiraProject;
		this.exists = existsSync;
	}

	/** Run the project's test command at the requested depth. */
	async runTests(options: AiraRunOptions = {}): Promise<AiraExecutionResult> {
		const profile = this.profile;
		if (!profile?.root) {
			return unavailable(this.cwd, "no project profile (no test command known)");
		}
		const command = resolveTestCommand(
			profile,
			options.depth ?? "project",
			options.target,
			this.cwd,
			this.detectSubproject,
			this.exists,
		);
		if (!command) {
			return unavailable(profile.root, "profile has no test command");
		}
		return this.launch(command, options, "test");
	}

	/** Run the project's build command. */
	async runBuild(options: Omit<AiraRunOptions, "depth" | "target"> = {}): Promise<AiraExecutionResult> {
		const profile = this.profile;
		if (!profile?.root) {
			return unavailable(this.cwd, "no project profile (no build command known)");
		}
		const command = profile.buildCommands[0];
		if (!command) {
			return unavailable(profile.root, "profile has no build command");
		}
		return this.launch({ command, cwd: profile.root }, options, "build");
	}

	/** Type/check run: profile check commands, falling back to build. */
	async runCheck(options: Omit<AiraRunOptions, "depth" | "target"> = {}): Promise<AiraExecutionResult> {
		const profile = this.profile;
		if (!profile?.root) {
			return unavailable(this.cwd, "no project profile (no check command known)");
		}
		let command = profile.checkCommands[0];
		let note: string | undefined;
		if (!command) {
			command = profile.buildCommands[0];
			note = command ? "no check command in profile; fell back to build command" : undefined;
		}
		if (!command) {
			return unavailable(profile.root, "profile has no check or build command");
		}
		return this.launch({ command, cwd: profile.root, note }, options, "check");
	}

	/** Run the project's dev command: background by default, reuse-aware. */
	async runDev(
		options: { reuse?: "new" | "reuse" | "restart"; timeoutMs?: number } = {},
	): Promise<AiraExecutionResult> {
		const profile = this.profile;
		if (!profile?.root) {
			return unavailable(this.cwd, "no project profile (no dev command known)");
		}
		const command = profile.devCommands[0];
		if (!command) {
			return unavailable(profile.root, "profile has no dev command");
		}
		return this.launch(
			{ command, cwd: profile.root },
			{ background: true, reuse: options.reuse ?? "reuse", timeoutMs: options.timeoutMs },
			"dev",
		);
	}

	private async launch(
		resolved: AiraResolvedCommand,
		options: AiraRunOptions,
		purpose: "test" | "build" | "check" | "dev",
	): Promise<AiraExecutionResult> {
		const request: AiraProcessRequest = { command: resolved.command, cwd: resolved.cwd };
		const startOptions: AiraStartOptions = { purpose };
		if (options.background !== undefined) {
			startOptions.mode = options.background === "auto" ? "auto" : options.background ? "background" : "foreground";
		}
		if (options.timeoutMs !== undefined) {
			startOptions.timeoutMs = options.timeoutMs;
		}
		if (purpose === "dev") {
			startOptions.mode ??= "background";
			startOptions.reuse ??= options.reuse ?? "reuse";
		}
		const result = await this.start(request, startOptions);
		if (resolved.note && !result.reason) {
			result.reason = resolved.note;
		}
		return result;
	}
}

// =========================================================================
// Command resolution (pure, exported for tests)
// =========================================================================

/**
 * Resolve the test command for a depth. Returns undefined when the profile
 * has no testable command.
 */
export function resolveTestCommand(
	profile: AiraProjectProfile,
	depth: AiraVerificationDepth,
	target: string | undefined,
	cwd: string,
	detectSubproject: (root: string) => AiraProjectProfile,
	exists: (path: string) => boolean,
): AiraResolvedCommand | undefined {
	const command = profile.testCommands[0];
	if (!command) {
		return undefined;
	}
	const root = profile.root ?? cwd;
	if (depth === "project" || !target) {
		return { command, cwd: root };
	}
	if (depth === "related") {
		const sub = nearestSubprojectRoot(target, root, exists);
		if (sub) {
			const subProfile = detectSubproject(sub);
			const subCommand = subProfile.testCommands[0];
			if (subCommand) {
				return targetedCommand(subCommand, subProfile, target, sub);
			}
		}
	}
	return targetedCommand(command, profile, target, root);
}

/**
 * Small toolchain-aware targeted suffix map. This is a documented, bounded
 * convention table (it appends a target to an existing profile command —
 * it does not redetect commands).
 */
export function targetedCommand(
	command: string,
	profile: AiraProjectProfile,
	target: string,
	root: string,
): AiraResolvedCommand {
	const rel = toRelativeTarget(root, target);
	if (!rel) {
		return { command, cwd: root, note: "target outside project root; ran project command" };
	}
	const managers = new Set(profile.packageManagers);
	const isNpmStyle = ["npm", "pnpm", "yarn", "bun"].some((m) => managers.has(m));
	if (isNpmStyle && /^(npm|pnpm|yarn|bun) /.test(command)) {
		// npm-run style: `npm test -- <target>`
		return { command: `${command} -- ${rel}`, cwd: root };
	}
	if (managers.has("dotnet") && (rel.endsWith(".csproj") || rel.endsWith(".sln"))) {
		return { command: `${command} ${rel}`, cwd: root };
	}
	if (["cargo", "go mod", "pip", "poetry", "uv", "pipenv"].some((m) => managers.has(m))) {
		return { command: `${command} ${rel}`, cwd: root };
	}
	// Generic fallback: pass the target through for tools that accept paths.
	return {
		command: `${command} ${rel}`,
		cwd: root,
		note: "toolchain without a documented targeted form; appended target",
	};
}

/** Relative target path, or undefined when the target escapes the root. */
export function toRelativeTarget(root: string, target: string): string | undefined {
	const rel = relative(resolve(root), resolve(target));
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return undefined;
	}
	return rel;
}

/** Nearest directory between `target` and `root` carrying a subpackage manifest. */
export function nearestSubprojectRoot(
	target: string,
	root: string,
	exists: (path: string) => boolean,
): string | undefined {
	if (!isAbsolute(target)) {
		return undefined;
	}
	const rootResolved = resolve(root);
	let dir = dirname(target);
	for (;;) {
		if (dir === rootResolved) {
			return undefined;
		}
		if (!dir.startsWith(`${rootResolved}${sep}`) && dir !== rootResolved) {
			return undefined; // walked past the root (defensive)
		}
		if (SUBPACKAGE_MARKERS.some((marker) => exists(resolve(dir, marker)))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir || parent === rootResolved) {
			return undefined;
		}
		dir = parent;
	}
}

function unavailable(cwd: string, reason: string): AiraExecutionResult {
	return {
		status: "unavailable",
		ok: false,
		command: "",
		cwd,
		startedAt: Date.now(),
		durationMs: 0,
		stdout: { text: "", truncated: false },
		stderr: { text: "", truncated: false },
		reason,
	};
}
