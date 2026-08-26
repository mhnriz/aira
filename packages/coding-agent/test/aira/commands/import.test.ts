import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleImportCommand } from "../../../src/aira/commands/import.ts";
import { getPiAgentDir } from "../../../src/aira/migration.ts";
import { getAiraAgentDir } from "../../../src/aira/paths.ts";

describe("aira import command", () => {
	const originalHome = process.env.HOME;
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "aira-import-cmd-"));
		process.env.HOME = home;
		delete process.env.AIRA_CODING_AGENT_DIR;
	});
	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		delete process.env.AIRA_CODING_AGENT_DIR;
		rmSync(home, { recursive: true, force: true });
		vi.restoreAllMocks();
	});
	it("returns false for non-import commands", async () => {
		expect(await handleImportCommand(["install", "npm:x"])).toBe(false);
	});
	it("requires an explicit source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = process.exitCode;
		expect(await handleImportCommand(["import"])).toBe(true);
		expect(errorSpy).toHaveBeenCalled();
		expect(errorSpy.mock.calls.join("\n")).toContain('Use "import --pi"');
		process.exitCode = exitCode;
	});
	it("reports when there is nothing to import", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await handleImportCommand(["import", "--pi"])).toBe(true);
		expect(logSpy.mock.calls.join("\n")).toContain("Nothing to import");
	});
	it("imports a Pi home when --pi is requested", async () => {
		mkdirSync(join(getPiAgentDir(), "extensions"), { recursive: true });
		writeFileSync(join(getPiAgentDir(), "extensions", "hello.ts"), "export default {}");
		writeFileSync(join(getPiAgentDir(), "settings.json"), "{}");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await handleImportCommand(["import", "--pi"])).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy.mock.calls.join("\n")).toContain("Pi home import");
		expect(existsSync(join(getAiraAgentDir(), "extensions", "hello.ts"))).toBe(true);
	});
	it("rejects unknown options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = process.exitCode;
		expect(await handleImportCommand(["import", "--pi", "--bogus"])).toBe(true);
		expect(errorSpy.mock.calls.join("\n")).toContain("Unknown option --bogus");
		process.exitCode = exitCode;
	});
});
