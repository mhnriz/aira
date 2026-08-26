import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPiAgentDir, hasImportablePiHome, importPiAgentDir } from "../../src/aira/migration.ts";
import { getAiraAgentDir, getAiraHome } from "../../src/aira/paths.ts";

describe("optional Pi home import", () => {
	const originalHome = process.env.HOME;
	let home: string;

	function seedPiHome(): void {
		mkdirSync(getPiAgentDir(), { recursive: true });
		writeFileSync(join(getPiAgentDir(), "settings.json"), JSON.stringify({ theme: "dark" }));
		writeFileSync(join(getPiAgentDir(), "auth.json"), JSON.stringify({ openai: "secret" }));
		writeFileSync(join(getPiAgentDir(), "keybindings.json"), "{}");
		mkdirSync(join(getPiAgentDir(), "extensions"), { recursive: true });
		writeFileSync(join(getPiAgentDir(), "extensions", "hello.ts"), "export default {}");
		mkdirSync(join(getPiAgentDir(), "sessions", "cwd-1"), { recursive: true });
		writeFileSync(join(getPiAgentDir(), "sessions", "cwd-1", "session.jsonl"), "{}");
		mkdirSync(join(getPiAgentDir(), "bin"), { recursive: true });
		writeFileSync(join(getPiAgentDir(), "bin", "fd"), "#!/bin/sh\n");
		chmodSync(join(getPiAgentDir(), "bin", "fd"), 0o755);
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "aira-import-"));
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
	});

	it("resolves the Pi source under the explicit ~/.pi home", () => {
		expect(getPiAgentDir()).toBe(join(home, ".pi", "agent"));
		expect(getAiraAgentDir()).toBe(join(home, ".aira", "agent"));
	});

	it("reports whether a Pi home is importable", () => {
		expect(hasImportablePiHome()).toBe(false);
		seedPiHome();
		expect(hasImportablePiHome()).toBe(true);
	});

	it("copies supported resources and skips secrets by default", () => {
		seedPiHome();
		const summary = importPiAgentDir();

		expect(summary.copiedCount).toBeGreaterThan(0);
		expect(existsSync(join(getAiraAgentDir(), "settings.json"))).toBe(true);
		expect(existsSync(join(getAiraAgentDir(), "extensions", "hello.ts"))).toBe(true);
		expect(existsSync(join(getAiraAgentDir(), "sessions", "cwd-1", "session.jsonl"))).toBe(true);
		expect(existsSync(join(getAiraAgentDir(), "auth.json"))).toBe(false);
		expect(existsSync(join(getAiraAgentDir(), "bin", "fd"))).toBe(true);
		const actionFor = (key: string) => summary.resources.find((entry) => entry.key === key)?.action;
		expect(actionFor("auth")).toBe("skipped-secrets");
		expect(actionFor("settings")).toBe("copied");
	});

	it("preserves executable bits on imported binaries", () => {
		seedPiHome();
		importPiAgentDir();
		const mode = statSync(join(getAiraAgentDir(), "bin", "fd")).mode;
		// eslint-disable-next-line no-bitwise
		expect(mode & 0o111).toBe(0o111);
	});

	it("copies credentials only with --include-secrets", () => {
		seedPiHome();
		const summary = importPiAgentDir({ includeSecrets: true });

		expect(existsSync(join(getAiraAgentDir(), "auth.json"))).toBe(true);
		expect(summary.resources.find((entry) => entry.key === "auth")?.action).toBe("copied");
	});

	it("writes an import marker in the Aira home after a real import", () => {
		seedPiHome();
		const summary = importPiAgentDir();

		const markerPath = join(getAiraHome(), "migration.json");
		expect(summary.markerPath).toBe(markerPath);
		const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as {
			schemaVersion: number;
			source: string;
			includeSecrets: boolean;
			resources: Array<{ key: string; rel: string }>;
		};
		expect(marker.schemaVersion).toBe(1);
		expect(marker.source).toBe(getPiAgentDir());
		expect(marker.includeSecrets).toBe(false);
		expect(marker.resources.some((entry) => entry.key === "settings")).toBe(true);
	});

	it("dry-run reports the plan without copying or writing a marker", () => {
		seedPiHome();
		const summary = importPiAgentDir({ dryRun: true });

		expect(summary.resources.some((entry) => entry.action === "dry-run")).toBe(true);
		expect(existsSync(join(getAiraAgentDir(), "settings.json"))).toBe(false);
		expect(existsSync(join(getAiraHome(), "migration.json"))).toBe(false);
		expect(summary.markerPath).toBeUndefined();
	});

	it("does not overwrite existing Aira resources by default", () => {
		seedPiHome();
		importPiAgentDir();
		writeFileSync(join(getAiraAgentDir(), "settings.json"), JSON.stringify({ theme: "mytheme" }));

		const summary = importPiAgentDir();
		expect(summary.resources.find((entry) => entry.key === "settings")?.action).toBe("skipped-existing");
		const stored = JSON.parse(readFileSync(join(getAiraAgentDir(), "settings.json"), "utf-8")) as {
			theme: string;
		};
		expect(stored).toEqual({ theme: "mytheme" });
	});

	it("overwrites existing resources with --force", () => {
		seedPiHome();
		importPiAgentDir();
		writeFileSync(join(getAiraAgentDir(), "settings.json"), JSON.stringify({ theme: "mytheme" }));

		const summary = importPiAgentDir({ overwrite: true });
		expect(summary.resources.find((entry) => entry.key === "settings")?.action).toBe("copied");
		const stored = JSON.parse(readFileSync(join(getAiraAgentDir(), "settings.json"), "utf-8")) as {
			theme: string;
		};
		expect(stored).toEqual({ theme: "dark" });
	});

	it("writes no marker when nothing was copied", () => {
		const summary = importPiAgentDir();
		expect(summary.copiedCount).toBe(0);
		expect(existsSync(join(getAiraHome(), "migration.json"))).toBe(false);
	});

	it("refuses to import a location into itself", () => {
		seedPiHome();
		expect(() => importPiAgentDir({ sourceAgentDir: join(home, ".aira", "agent") })).toThrow("into itself");
	});
});
