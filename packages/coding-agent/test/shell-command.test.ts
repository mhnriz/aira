import { describe, expect, it } from "vitest";
import { classifyShellCommand, type ShellPurposeKind } from "../src/core/tools/shell-command.ts";

function kindOf(command: string): ShellPurposeKind {
	return classifyShellCommand(command).kind;
}

describe("classifyShellCommand", () => {
	it("detects validation commands behind package-manager wrappers", () => {
		expect(kindOf("npm test")).toBe("test");
		expect(kindOf("npm run build")).toBe("build");
		expect(kindOf("npm run check")).toBe("check");
		expect(kindOf("bun test")).toBe("test");
		expect(kindOf("npx vitest run")).toBe("test");
		expect(kindOf("pnpm exec tsc")).toBe("check");
	});

	it("detects direct runner invocations", () => {
		expect(kindOf("./test.sh")).toBe("test");
		expect(kindOf("vitest")).toBe("test");
		expect(kindOf("pytest -q")).toBe("test");
		expect(kindOf("tsc --noEmit")).toBe("check");
		expect(kindOf("eslint .")).toBe("check");
		expect(kindOf("vite build")).toBe("build");
	});

	it("detects Windows-style test invocations and targets", () => {
		expect(kindOf(".\\test.ps1")).toBe("test");
		expect(kindOf(".\\test.bat")).toBe("test");
		const info = classifyShellCommand("vitest run test\\core\\tools");
		expect(info.kind).toBe("test");
		expect(info.target).toBe("test\\core\\tools");
	});

	it("leaves routine shell work and POSIX conditionals unclassified", () => {
		expect(kindOf("ls")).toBe("bash");
		expect(kindOf("git status --short")).toBe("bash");
		expect(kindOf("cat package.json")).toBe("bash");
		expect(kindOf("npm ci")).toBe("bash");
		expect(kindOf("npm run dev")).toBe("bash");
		expect(kindOf("echo test")).toBe("bash");
		expect(kindOf("test -f package.json")).toBe("bash");
		expect(kindOf("rm -rf build")).toBe("bash");
	});
});
