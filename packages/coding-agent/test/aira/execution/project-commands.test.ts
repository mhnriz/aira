import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AiraProjectCommandRunner,
	nearestSubprojectRoot,
	resolveTestCommand,
	targetedCommand,
	toRelativeTarget,
} from "../../../src/aira/execution/project-commands.ts";
import type { AiraExecutionResult, AiraProcessRequest, AiraStartOptions } from "../../../src/aira/execution/types.ts";
import { detectAiraProject } from "../../../src/aira/project/detect.ts";
import type { AiraProjectConfidence, AiraProjectProfile } from "../../../src/aira/project/profile.ts";

/**
 * Phase 6 project-command suite: profile command CONSUMPTION (no redetection),
 * depth semantics (targeted/related/project), check fallback, and dev reuse —
 * with a recording stub for the launch side and real fixture directories for
 * subpackage resolution.
 */

function profile(overrides: Partial<AiraProjectProfile>): AiraProjectProfile {
	return {
		root: "/proj",
		git: { hasGit: true, root: "/proj" },
		languages: ["TypeScript"],
		frameworks: [],
		packageManagers: ["npm"],
		testCommands: ["npm test"],
		buildCommands: ["npm run build"],
		checkCommands: [],
		devCommands: ["npm run dev"],
		browserRelevant: false,
		deploymentHints: [],
		confidence: "high" as AiraProjectConfidence,
		...overrides,
	};
}

/** Stub start() that records request+options and returns a canned result. */
function recordingRunner(
	profile_: AiraProjectProfile | undefined,
	cwd: string,
	calls: Array<{ request: AiraProcessRequest; options?: AiraStartOptions }>,
	canned?: Partial<AiraExecutionResult>,
): AiraProjectCommandRunner {
	return new AiraProjectCommandRunner({
		profile: profile_,
		cwd,
		start: async (request, options) => {
			calls.push({ request, options });
			return {
				status: "exited",
				ok: true,
				command: request.command ?? "",
				cwd: request.cwd,
				startedAt: 0,
				durationMs: 1,
				exitCode: 0,
				stdout: { text: "", truncated: false },
				stderr: { text: "", truncated: false },
				...canned,
			};
		},
	});
}

describe("Aira project-aware command resolution (Phase 6)", () => {
	it("project depth uses the profile's first test command at the profile root", () => {
		const calls: Array<{ request: AiraProcessRequest; options?: AiraStartOptions }> = [];
		const runner = recordingRunner(profile({ testCommands: ["npm test"] }), "/proj", calls);
		return runner.runTests({ depth: "project" }).then(() => {
			expect(calls).toHaveLength(1);
			expect(calls[0]?.request.command).toBe("npm test");
			expect(calls[0]?.request.cwd).toBe("/proj");
		});
	});

	it("targeted npm-style test appends `-- <relative target>`", () => {
		const p = profile({ packageManagers: ["npm"], testCommands: ["npm test"] });
		expect(targetedCommand("npm test", p, "/proj/src/tray.test.ts", "/proj").command).toBe(
			"npm test -- src/tray.test.ts",
		);
		const pnpm = profile({ packageManagers: ["pnpm"], testCommands: ["pnpm test"] });
		expect(targetedCommand("pnpm test", pnpm, "/proj/src/tray.test.ts", "/proj").command).toBe(
			"pnpm test -- src/tray.test.ts",
		);
	});

	it("targeted pytest/cargo/go forms append the path directly", () => {
		const py = profile({ packageManagers: ["pip"], testCommands: ["python -m pytest"] });
		expect(targetedCommand("python -m pytest", py, "/proj/tests/foo.py", "/proj").command).toBe(
			"python -m pytest tests/foo.py",
		);
		const cargo = profile({ packageManagers: ["cargo"], testCommands: ["cargo test"] });
		expect(targetedCommand("cargo test", cargo, "/proj/crates/core", "/proj").command).toBe("cargo test crates/core");
		const go = profile({ packageManagers: ["go mod"], testCommands: ["go test ./..."] });
		expect(targetedCommand("go test ./...", go, "/proj/pkg/util", "/proj").command).toBe("go test ./... pkg/util");
	});

	it("targeted dotnet form applies to project files only", () => {
		const dotnet = profile({ packageManagers: ["dotnet"], testCommands: ["dotnet test"] });
		expect(targetedCommand("dotnet test", dotnet, "/proj/src/App.csproj", "/proj").command).toBe(
			"dotnet test src/App.csproj",
		);
		// A non-project target falls back with a note.
		const fallback = targetedCommand("dotnet test", dotnet, "/proj/src/Util.cs", "/proj");
		expect(fallback.command).toBe("dotnet test src/Util.cs");
		expect(fallback.note).toBeTruthy();
	});

	it("targets outside the project root fall back to the project command", () => {
		const p = profile({ testCommands: ["npm test"] });
		const resolved = targetedCommand("npm test", p, "/elsewhere/foo.test.ts", "/proj");
		expect(resolved.command).toBe("npm test");
		expect(resolved.note).toContain("outside project root");
	});

	it("no profile / no test command yields a truthful unavailable result", async () => {
		const calls: Array<{ request: AiraProcessRequest; options?: AiraStartOptions }> = [];
		const noProfile = recordingRunner(undefined, "/proj", calls);
		const result = await noProfile.runTests();
		expect(result.status).toBe("unavailable");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("no project profile");

		const noCommand = recordingRunner(profile({ testCommands: [] }), "/proj", calls);
		const result2 = await noCommand.runTests();
		expect(result2.status).toBe("unavailable");
		expect(result2.reason).toContain("no test command");
	});

	it("runBuild / runCheck consume the profile's build and check commands", async () => {
		const calls: Array<{ request: AiraProcessRequest; options?: AiraStartOptions }> = [];
		const runner = recordingRunner(
			profile({ buildCommands: ["npm run build"], checkCommands: ["npx tsc --noEmit"] }),
			"/proj",
			calls,
		);
		await runner.runBuild();
		expect(calls[0]?.request.command).toBe("npm run build");
		expect(calls[0]?.options?.purpose).toBe("build");

		await runner.runCheck();
		expect(calls[1]?.request.command).toBe("npx tsc --noEmit");
		expect(calls[1]?.options?.purpose).toBe("check");
	});

	it("runCheck falls back to the build command with an explicit note", async () => {
		const calls: Array<{ request: AiraProcessRequest; options?: AiraStartOptions }> = [];
		const runner = recordingRunner(profile({ buildCommands: ["npm run build"], checkCommands: [] }), "/proj", calls);
		const result = await runner.runCheck();
		expect(calls[0]?.request.command).toBe("npm run build");
		expect(result.reason).toContain("fell back to build");
	});

	it("runDev is background by default and reuse-aware", async () => {
		const calls: Array<{ request: AiraProcessRequest; options?: AiraStartOptions }> = [];
		const runner = recordingRunner(profile({ devCommands: ["npm run dev"] }), "/proj", calls);
		await runner.runDev();
		expect(calls[0]?.request.command).toBe("npm run dev");
		expect(calls[0]?.options?.mode).toBe("background");
		expect(calls[0]?.options?.reuse).toBe("reuse");
		expect(calls[0]?.options?.purpose).toBe("dev");
	});

	it("related depth resolves the nearest subpackage with its own profile", async () => {
		const root = join(tmpdir(), `aira-p6-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", scripts: { test: "npm test" } }));
		writeFileSync(
			join(root, "packages", "core", "package.json"),
			JSON.stringify({ name: "core", scripts: { test: "npm run test:core" } }),
		);
		const target = join(root, "packages", "core", "src", "thing.test.ts");

		const sub = nearestSubprojectRoot(target, root, existsSync);
		expect(sub).toBe(join(root, "packages", "core"));

		const resolved = resolveTestCommand(
			detectAiraProject(root),
			"related",
			target,
			root,
			detectAiraProject,
			existsSync,
		);
		expect(resolved?.cwd).toBe(join(root, "packages", "core"));
		expect(resolved?.command).toContain("test:core");
	});

	it("related depth degrades to targeted at the root when no subpackage exists", () => {
		const p = profile({ packageManagers: ["npm"], testCommands: ["npm test"] });
		const noSubs = (path: string) => path.includes("definitely-missing");
		const resolved = resolveTestCommand(p, "related", "/proj/src/tray.test.ts", "/proj", () => p, noSubs);
		expect(resolved?.command).toBe("npm test -- src/tray.test.ts");
		expect(resolved?.cwd).toBe("/proj");
	});

	it("toRelativeTarget rejects escaping paths", () => {
		expect(toRelativeTarget("/proj", "/proj/src/x.ts")).toBe("src/x.ts");
		expect(toRelativeTarget("/proj", "/proj")).toBe("");
		expect(toRelativeTarget("/proj", "../x.ts")).toBeUndefined();
		expect(toRelativeTarget("/proj", "/elsewhere/x.ts")).toBeUndefined();
	});

	it("foreground/background/auto pass through to the runtime", async () => {
		const calls: Array<{ request: AiraProcessRequest; options?: AiraStartOptions }> = [];
		const runner = recordingRunner(profile({ testCommands: ["npm test"] }), "/proj", calls);
		await runner.runTests({ background: "auto", timeoutMs: 5000 });
		expect(calls[0]?.options?.mode).toBe("auto");
		expect(calls[0]?.options?.timeoutMs).toBe(5000);
	});
});
