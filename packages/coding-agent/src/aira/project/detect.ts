/**
 * Aira project — evidence-based, lightweight workspace detection.
 *
 * Detection inspects repository/workspace signals (Git markers, manifests,
 * build files, languages, frameworks, package managers, conventional commands)
 * and derives a `ProjectProfile`. It is intentionally NOT repository indexing
 * or semantic intelligence — that is roadmap Phase 5+. It only reads bounded,
 * top-level files and small manifest contents.
 *
 * Safety boundary ("project scope"): the user's home directory — and any
 * parent of it — is never classified as a giant project. Detection stops
 * climbing at the home boundary and prefers the NEAREST defensible project
 * root (a dir carrying a Git marker or a recognized manifest/build file).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type AiraProjectConfidence, type AiraProjectProfile, NO_AIRA_PROJECT } from "./profile.ts";

export interface DetectProjectOptions {
	/** Home boundary; defaults to the OS home. Overridable for tests. */
	home?: string;
}

const GIT_MARKER = ".git";

const FRONTEND_FRAMEWORKS = new Set([
	"react",
	"vue",
	"svelte",
	"angular",
	"next",
	"nuxt",
	"remix",
	"solid",
	"gatsby",
	"astro",
]);
const WEB_FRAMEWORKS = new Set([
	"express",
	"fastify",
	"hono",
	"django",
	"flask",
	"fastapi",
	"rails",
	"phoenix",
	"next",
	"remix",
]);

interface DirEnv {
	root: string;
	names: Set<string>;
}

/** True when `a` is `b` or an ancestor of `b` (boundary check). */
function isAncestorOrSelf(a: string, b: string): boolean {
	if (a === b) return true;
	return b.startsWith(`${a}${sep}`);
}

/** True when a directory carries a `.git` marker (a directory or a worktree file). */
function hasGitMarker(dir: string): boolean {
	const candidate = join(dir, GIT_MARKER);
	if (existsSync(candidate)) return true;
	return false;
}

/** True when a directory has recognized manifest/build evidence at its top level. */
function hasProjectEvidence(dir: string): boolean {
	const names = readdirNames(dir);
	return names.some((n) => isManifestName(n));
}

function readdirNames(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function isManifestName(name: string): boolean {
	if (/\.(csproj|sln|gemspec)$/.test(name)) return true;
	return new Set([
		"package.json",
		"pyproject.toml",
		"requirements.txt",
		"setup.py",
		"setup.cfg",
		"Pipfile",
		"Cargo.toml",
		"go.mod",
		"global.json",
		"CMakeLists.txt",
		"Makefile",
		"meson.build",
		"Gemfile",
		"pom.xml",
		"build.gradle",
		"build.gradle.kts",
		"settings.gradle",
		"composer.json",
		"Package.swift",
		"mix.exs",
		"Dockerfile",
		"docker-compose.yml",
		"docker-compose.yaml",
		"compose.yaml",
		"tsconfig.json",
	]).has(name);
}

/** Read a small text file, or undefined on any error. */
function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Substring match of a manifest's raw text against known package names. */
function textHints(text: string | undefined, tokens: Iterable<string>): Set<string> {
	const found = new Set<string>();
	if (!text) return found;
	for (const token of tokens) {
		if (text.includes(token)) found.add(token);
	}
	return found;
}

function depTokens(deps: Record<string, unknown> | undefined): string[] {
	const tokens: string[] = [];
	for (const name of Object.keys(deps ?? {})) {
		const lower = name.toLowerCase().replace(/^(@[a-z0-9-]+\/)?/, "");
		tokens.push(lower);
	}
	return tokens;
}

type Commands = { test: string[]; build: string[]; dev: string[] };

interface PartialProfile {
	languages: Set<string>;
	frameworks: Set<string>;
	managers: Set<string>;
	commands: Commands;
	browser: boolean;
	deployment: Set<string>;
}

function emptyPartial(): PartialProfile {
	return {
		languages: new Set(),
		frameworks: new Set(),
		managers: new Set(),
		commands: { test: [], build: [], dev: [] },
		browser: false,
		deployment: new Set(),
	};
}

function addCommands(target: Commands, src: Commands): void {
	for (const k of ["test", "build", "dev"] as const) {
		if (src[k].length > 0 && target[k].length === 0) {
			target[k] = src[k];
		}
	}
}

/** Node/JavaScript/TypeScript via package.json + lockfiles. */
function detectNode(env: DirEnv, out: PartialProfile): void {
	const pkgText = readText(join(env.root, "package.json"));
	if (pkgText === undefined) return;

	let pkg: {
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	} = {};
	try {
		pkg = JSON.parse(pkgText) as typeof pkg;
	} catch {
		pkg = {};
	}

	if (env.names.has("tsconfig.json")) {
		out.languages.add("TypeScript");
	} else {
		out.languages.add("JavaScript");
	}

	// Package manager from lockfiles, defaulting to npm.
	if (env.names.has("pnpm-lock.yaml")) out.managers.add("pnpm");
	else if (env.names.has("yarn.lock")) out.managers.add("yarn");
	else if (env.names.has("bun.lock") || env.names.has("bun.lockb")) out.managers.add("bun");
	else if (env.names.has("package-lock.json")) out.managers.add("npm");
	else out.managers.add("npm");

	// Frameworks + browser relevance from dependencies.
	const allDeps = depTokens(pkg.dependencies).concat(depTokens(pkg.devDependencies));
	for (const token of allDeps) {
		if (FRONTEND_FRAMEWORKS.has(token)) out.frameworks.add(token);
		if (WEB_FRAMEWORKS.has(token)) out.frameworks.add(token);
	}
	if (allDeps.some((t) => FRONTEND_FRAMEWORKS.has(t) || WEB_FRAMEWORKS.has(t))) {
		out.browser = true;
	}

	const pm = out.managers.has("npm")
		? "npm"
		: out.managers.has("yarn")
			? "yarn"
			: out.managers.has("pnpm")
				? "pnpm"
				: "bun";
	const scripts = pkg.scripts ?? {};
	addCommands(out.commands, {
		test: [scripts.test ?? `${pm} test`],
		build: [scripts.build ?? `${pm} run build`],
		dev: [scripts.dev ?? `${pm} run dev`],
	});
}

/** Python via pyproject/requirements/setup + lockfiles. */
function detectPython(env: DirEnv, out: PartialProfile): void {
	if (
		!["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "manage.py"].some((n) =>
			env.names.has(n),
		)
	) {
		return;
	}
	out.languages.add("Python");

	if (env.names.has("poetry.lock")) out.managers.add("poetry");
	else if (env.names.has("uv.lock")) out.managers.add("uv");
	else if (env.names.has("Pipfile")) out.managers.add("pipenv");
	else out.managers.add("pip");

	const pyproject = readText(join(env.root, "pyproject.toml"));
	const hints = textHints(pyproject, ["django", "flask", "fastapi", "uvicorn"]);
	for (const token of hints) {
		out.frameworks.add(token);
		if (token === "django" || token === "flask" || token === "fastapi") out.browser = true;
	}
	if (env.names.has("manage.py") && !out.frameworks.has("django")) out.frameworks.add("django");
	if (env.names.has("manage.py")) out.browser = true;

	addCommands(out.commands, {
		test: ["python -m pytest"],
		build: ["python -m build"],
		dev: out.frameworks.has("django") ? ["python manage.py runserver"] : ["python -m uvicorn app.main:app"],
	});
}

/** Go via go.mod. */
function detectGo(env: DirEnv, out: PartialProfile): void {
	if (!env.names.has("go.mod")) return;
	out.languages.add("Go");
	out.managers.add("go mod");
	addCommands(out.commands, {
		test: ["go test ./..."],
		build: ["go build ./..."],
		dev: ["go run ."],
	});
}

/** Rust via Cargo.toml. */
function detectRust(env: DirEnv, out: PartialProfile): void {
	if (!env.names.has("Cargo.toml")) return;
	out.languages.add("Rust");
	out.managers.add("cargo");
	addCommands(out.commands, {
		test: ["cargo test"],
		build: ["cargo build"],
		dev: ["cargo run"],
	});
}

/** .NET / C# via *.csproj, *.sln, global.json. */
function detectDotnet(env: DirEnv, out: PartialProfile): void {
	const hasCsProj = [...env.names].some((n) => n.endsWith(".csproj"));
	if (!hasCsProj && !env.names.has("global.json") && ![...env.names].some((n) => n.endsWith(".sln"))) return;
	out.languages.add("C#");
	out.managers.add("dotnet");
	addCommands(out.commands, {
		test: ["dotnet test"],
		build: ["dotnet build"],
		dev: ["dotnet run"],
	});
}

/** C / C++ via CMake/meson, or Makefile plus C/C++ sources. */
function detectCpp(env: DirEnv, out: PartialProfile): void {
	const hasCmake = env.names.has("CMakeLists.txt");
	const hasMeson = env.names.has("meson.build");
	const sourceHints = [...env.names].some((n) => /\.(c|cc|cpp|cxx|h|hpp|hh)$/.test(n));
	const hasMake = env.names.has("Makefile");
	if (!hasCmake && !hasMeson && !(hasMake && sourceHints)) return;

	out.languages.add("C/C++");
	if (hasCmake) out.managers.add("cmake");
	else if (hasMeson) out.managers.add("meson");

	addCommands(out.commands, {
		test: [hasCmake ? "ctest" : "make test"],
		build: [hasCmake ? "cmake --build ." : hasMake ? "make" : "meson compile"],
		dev: [],
	});
}

/** Generic Makefile commands (no strong language signal). */
function detectMakefile(env: DirEnv, out: PartialProfile): void {
	if (!env.names.has("Makefile")) return;
	addCommands(out.commands, {
		test: ["make test"],
		build: ["make"],
		dev: ["make run"],
	});
}

/** Ruby via Gemfile / *.gemspec. */
function detectRuby(env: DirEnv, out: PartialProfile): void {
	if (!env.names.has("Gemfile") && ![...env.names].some((n) => n.endsWith(".gemspec"))) return;
	out.languages.add("Ruby");
	out.managers.add("bundler");
	if (readText(join(env.root, "Gemfile"))?.includes("rails")) {
		out.frameworks.add("rails");
		out.browser = true;
	}
	addCommands(out.commands, {
		test: ["bundle exec rspec"],
		build: [],
		dev: out.frameworks.has("rails") ? ["bundle exec rails server"] : [],
	});
}

/** Java / Kotlin via Maven/Gradle. */
function detectJvm(env: DirEnv, out: PartialProfile): void {
	const hasMaven = env.names.has("pom.xml");
	const hasGradle = ["build.gradle", "build.gradle.kts", "settings.gradle"].some((n) => env.names.has(n));
	if (!hasMaven && !hasGradle) return;
	out.languages.add("Java");
	if (hasMaven) out.managers.add("maven");
	if (hasGradle) out.managers.add("gradle");
	addCommands(out.commands, {
		test: [hasMaven ? "mvn test" : "./gradlew test"],
		build: [hasMaven ? "mvn package" : "./gradlew build"],
		dev: [hasMaven ? "mvn spring-boot:run" : "./gradlew run"],
	});
}

/** PHP via composer.json. */
function detectPhp(env: DirEnv, out: PartialProfile): void {
	if (!env.names.has("composer.json")) return;
	out.languages.add("PHP");
	out.managers.add("composer");
	addCommands(out.commands, {
		test: ["composer test"],
		build: [],
		dev: [],
	});
}

/** Swift via Package.swift. */
function detectSwift(env: DirEnv, out: PartialProfile): void {
	if (!env.names.has("Package.swift")) return;
	out.languages.add("Swift");
	out.managers.add("swift");
	addCommands(out.commands, {
		test: ["swift test"],
		build: ["swift build"],
		dev: ["swift run"],
	});
}

/** Elixir via mix.exs. */
function detectElixir(env: DirEnv, out: PartialProfile): void {
	if (!env.names.has("mix.exs")) return;
	out.languages.add("Elixir");
	out.managers.add("mix");
	out.browser = readText(join(env.root, "mix.exs"))?.includes("phoenix") ? true : out.browser;
	addCommands(out.commands, {
		test: ["mix test"],
		build: [],
		dev: ["mix phx.server"],
	});
}

/** Browser relevance from an HTML entrypoint. */
function detectBrowserEntrypoint(env: DirEnv, out: PartialProfile): void {
	if (env.names.has("index.html") || env.names.has("vite.config.ts") || env.names.has("vite.config.js")) {
		out.browser = true;
	}
}

/** Deployment/CI signals. */
function detectDeployment(env: DirEnv, out: PartialProfile): void {
	if (
		env.names.has("Dockerfile") ||
		env.names.has("docker-compose.yml") ||
		env.names.has("docker-compose.yaml") ||
		env.names.has("compose.yaml")
	) {
		out.deployment.add("docker");
	}
	if (env.names.has(".github")) out.deployment.add("github-actions");
	if (env.names.has(".gitlab-ci.yml")) out.deployment.add("gitlab-ci");
	if (env.names.has(".circleci")) out.deployment.add("circleci");
	if (env.names.has("vercel.json")) out.deployment.add("vercel");
	if (env.names.has("netlify.toml")) out.deployment.add("netlify");
	if (env.names.has("serverless.yml") || env.names.has("serverless.yaml")) out.deployment.add("serverless");
}

/** Derive confidence from the strength/amount of evidence. */
function confidenceOf(hasGit: boolean, out: PartialProfile): AiraProjectConfidence {
	let score = hasGit ? 1 : 0;
	score += out.languages.size;
	if (out.deployment.size > 0) score += 1;
	if (out.browser) score += 1;
	if (score >= 3) return "high";
	if (score === 2) return "medium";
	if (score === 1) return "low";
	return "none";
}

/** Detect the full profile at/around the given cwd. */
export function detectAiraProject(cwd: string, options?: DetectProjectOptions): AiraProjectProfile {
	const home = resolve(options?.home ?? homedir());
	const start = resolve(cwd);
	if (!existsSync(start)) return NO_AIRA_PROJECT;

	// Safety boundary: the home directory and any parent of it is never a project.
	if (isAncestorOrSelf(start, home)) return NO_AIRA_PROJECT;

	// Climb from cwd upward, stopping at (and never including) the home boundary.
	const ancestors: string[] = [];
	let dir = start;
	for (;;) {
		if (dir === home) break;
		ancestors.push(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const defensibleRoot = ancestors.find((d) => hasGitMarker(d) || hasProjectEvidence(d));
	if (!defensibleRoot) return NO_AIRA_PROJECT;
	const gitRoot = ancestors.find((d) => hasGitMarker(d));

	const out = emptyPartial();
	const env: DirEnv = { root: defensibleRoot, names: new Set(readdirNames(defensibleRoot)) };

	detectNode(env, out);
	detectPython(env, out);
	detectGo(env, out);
	detectRust(env, out);
	detectDotnet(env, out);
	detectCpp(env, out);
	detectMakefile(env, out);
	detectRuby(env, out);
	detectJvm(env, out);
	detectPhp(env, out);
	detectSwift(env, out);
	detectElixir(env, out);
	detectBrowserEntrypoint(env, out);
	detectDeployment(env, out);

	return {
		root: defensibleRoot,
		git: { hasGit: gitRoot !== undefined, root: gitRoot },
		languages: [...out.languages].sort(),
		frameworks: [...out.frameworks].sort(),
		packageManagers: [...out.managers].sort(),
		testCommands: out.commands.test,
		buildCommands: out.commands.build,
		devCommands: out.commands.dev,
		browserRelevant: out.browser,
		deploymentHints: [...out.deployment].sort(),
		confidence: confidenceOf(gitRoot !== undefined, out),
	};
}
