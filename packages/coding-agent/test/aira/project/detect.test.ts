import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAiraProject } from "../../../src/aira/project/index.ts";
import { NO_AIRA_PROJECT } from "../../../src/aira/project/profile.ts";

/** Create a throwaway temp directory and return its path. */
function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "aira-proj-"));
}

/** Create a throwaway fake home (never under the project dirs). */
function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "aira-home-"));
}

function file(dir: string, name: string, content = ""): void {
	writeFileSync(join(dir, name), content);
}

describe("Aira project detection", () => {
	it("classifies a Node repository with Git evidence", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".git"));
		file(dir, "package.json", JSON.stringify({ name: "web", scripts: { test: "jest", dev: "vite" } }));

		const p = detectAiraProject(dir, { home: makeHome() });

		expect(p.root).toBe(dir);
		expect(p.git.hasGit).toBe(true);
		expect(p.git.root).toBe(dir);
		expect(p.languages).toEqual(["JavaScript"]);
		expect(p.packageManagers).toEqual(["npm"]);
		expect(p.testCommands).toEqual(["jest"]);
		expect(p.buildCommands).toEqual(["npm run build"]);
		expect(p.devCommands).toEqual(["vite"]);
		expect(p.confidence).toBe("medium");
	});

	it("detects TypeScript from a tsconfig, plus a frontend framework and browser relevance", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".git"));
		file(dir, "package.json", JSON.stringify({ dependencies: { react: "^18" } }));
		file(dir, "tsconfig.json");

		const p = detectAiraProject(dir, { home: makeHome() });

		expect(p.languages).toEqual(["TypeScript"]);
		expect(p.frameworks).toContain("react");
		expect(p.browserRelevant).toBe(true);
	});

	it("classifies a Python project", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".git"));
		file(dir, "pyproject.toml", '[project]\nname = "api"\n');

		const p = detectAiraProject(dir, { home: makeHome() });

		expect(p.languages).toEqual(["Python"]);
		expect(p.packageManagers).toEqual(["pip"]);
		expect(p.testCommands).toEqual(["python -m pytest"]);
		expect(p.buildCommands).toEqual(["python -m build"]);
		expect(p.confidence).toBe("medium");
	});

	it("classifies a .NET / C# project", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".git"));
		file(dir, "App.csproj");

		const p = detectAiraProject(dir, { home: makeHome() });

		expect(p.languages).toEqual(["C#"]);
		expect(p.packageManagers).toEqual(["dotnet"]);
		expect(p.testCommands).toEqual(["dotnet test"]);
		expect(p.buildCommands).toEqual(["dotnet build"]);
		expect(p.devCommands).toEqual(["dotnet run"]);
	});

	it("classifies a C/C++ project from CMake", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".git"));
		file(dir, "CMakeLists.txt");

		const p = detectAiraProject(dir, { home: makeHome() });

		expect(p.languages).toEqual(["C/C++"]);
		expect(p.packageManagers).toEqual(["cmake"]);
		expect(p.testCommands).toEqual(["ctest"]);
		expect(p.buildCommands).toEqual(["cmake --build ."]);
	});

	it("classifies a mixed Node+Python repository as multiple languages with high confidence", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".git"));
		file(dir, "package.json", JSON.stringify({ name: "fullstack" }));
		file(dir, "pyproject.toml");
		file(dir, "Dockerfile");

		const p = detectAiraProject(dir, { home: makeHome() });

		expect([...p.languages].sort()).toEqual(["JavaScript", "Python"]);
		expect(p.deploymentHints).toContain("docker");
		expect(p.confidence).toBe("high");
	});

	it("detects a Dockerfile and CI as deployment hints", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".git"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		file(dir, "Dockerfile");
		file(dir, "package.json", JSON.stringify({}));

		const p = detectAiraProject(dir, { home: makeHome() });

		expect(p.deploymentHints).toEqual(["docker", "github-actions"]);
	});

	it("prefers the nearest defensible project root and still reports the Git root", () => {
		const outer = makeDir();
		mkdirSync(join(outer, ".git"));
		const inner = join(outer, "inner");
		mkdirSync(inner);
		file(inner, "package.json", JSON.stringify({ name: "subpkg" }));
		// a src dir with no evidence should not change the root
		const src = join(inner, "src");
		mkdirSync(src);
		file(src, "main.ts", "// nothing");

		const p = detectAiraProject(src, { home: makeHome() });

		expect(p.root).toBe(inner);
		expect(p.git.root).toBe(outer);
		expect(p.git.hasGit).toBe(true);
		expect(p.languages).toEqual(["JavaScript"]);
	});

	it("does not treat an arbitrary working-directory parent as a giant project", () => {
		const workspace = makeDir();
		const sub = join(workspace, "sub");
		mkdirSync(join(sub, ".git"), { recursive: true });
		file(sub, "package.json", JSON.stringify({}));

		// Detection from the parent workspace (no own signals) => no project.
		const p = detectAiraProject(workspace, { home: makeHome() });

		expect(p).toEqual(NO_AIRA_PROJECT);
	});

	it("never treats the home directory as a project, even with a .git marker", () => {
		const home = makeHome();
		mkdirSync(join(home, ".git"));

		const p = detectAiraProject(home, { home });

		expect(p).toEqual(NO_AIRA_PROJECT);
		expect(p.confidence).toBe("none");
		expect(p.root).toBeUndefined();
	});

	it("never treats a parent of home as a project", () => {
		const parent = makeDir();
		const home = join(parent, "home");
		mkdirSync(home);

		const p = detectAiraProject(parent, { home });

		expect(p).toEqual(NO_AIRA_PROJECT);
	});

	it("returns no project for an empty directory without signals", () => {
		const dir = makeDir();

		const p = detectAiraProject(dir, { home: makeHome() });

		expect(p).toEqual(NO_AIRA_PROJECT);
	});

	it("returns no project for a nonexistent cwd", () => {
		expect(detectAiraProject(join(tmpdir(), "does-not-exist-xyz"), { home: makeHome() })).toEqual(NO_AIRA_PROJECT);
	});
});
