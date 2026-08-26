import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	displayPathUnderHome,
	getAiraAgentDir,
	getAiraAgentsDir,
	getAiraCacheDir,
	getAiraExtensionsDir,
	getAiraHome,
	getAiraHomeResources,
	getAiraProjectDir,
	getAiraSessionsDir,
	getAiraSkillsDir,
	getAiraThemesDir,
} from "../../src/aira/paths.ts";
import { CONFIG_DIR_NAME, LEGACY_ENV_AGENT_DIR } from "../../src/config.ts";

describe("Aira home path helpers", () => {
	const originalHome = process.env.HOME;
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "aira-home-"));
		process.env.HOME = home;
		delete process.env.AIRA_CODING_AGENT_DIR;
		delete process.env[LEGACY_ENV_AGENT_DIR];
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		delete process.env.AIRA_CODING_AGENT_DIR;
		delete process.env[LEGACY_ENV_AGENT_DIR];
		rmSync(home, { recursive: true, force: true });
	});

	it("resolves the canonical home under ~/.aira", () => {
		expect(getAiraHome()).toBe(join(home, CONFIG_DIR_NAME));
		expect(getAiraHome()).not.toContain(".pi");
	});

	it("resolves the agent dir under the Aira home", () => {
		expect(getAiraAgentDir()).toBe(join(home, CONFIG_DIR_NAME, "agent"));
		expect(getAiraAgentDir()).not.toContain(".pi");
	});

	it("resolves project-local config as <cwd>/.aira", () => {
		expect(getAiraProjectDir("/path/to/project")).toBe(`/path/to/project/${CONFIG_DIR_NAME}`);
	});

	it("places the Phase 2 resources under the Aira home", () => {
		expect(getAiraSessionsDir().startsWith(`${getAiraHome()}/`)).toBe(true);
		expect(getAiraExtensionsDir().startsWith(`${getAiraHome()}/`)).toBe(true);
		expect(getAiraSkillsDir().startsWith(`${getAiraHome()}/`)).toBe(true);
		expect(getAiraThemesDir().startsWith(`${getAiraHome()}/`)).toBe(true);
		expect(getAiraAgentsDir().startsWith(`${getAiraHome()}/`)).toBe(true);
		expect(getAiraCacheDir().startsWith(`${getAiraHome()}/`)).toBe(true);
	});

	it("covers major resources in the home resource registry", () => {
		const resources = getAiraHomeResources();
		const keys = new Set(resources.map((entry) => entry.key));
		for (const key of ["settings", "sessions", "cache", "extensions", "skills", "themes", "agents", "debugLog"]) {
			expect(keys.has(key), `missing ${key}`).toBe(true);
		}
		for (const entry of resources) {
			expect(entry.path.startsWith(`${getAiraHome()}/`), entry.key).toBe(true);
		}
	});

	it("honors the legacy PI_CODING_AGENT_DIR compatibility alias", () => {
		const legacyDir = join(home, "legacy-agent");
		process.env[LEGACY_ENV_AGENT_DIR] = legacyDir;
		expect(getAiraAgentDir()).toBe(legacyDir);
	});
});

describe("displayPathUnderHome", () => {
	const originalHome = process.env.HOME;

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
	});

	it("renders home paths with a tilde", () => {
		process.env.HOME = "/Users/x";
		expect(displayPathUnderHome("/Users/x/.aira")).toBe("~/.aira");
	});

	it("keeps paths outside the home absolute", () => {
		process.env.HOME = "/Users/x";
		expect(displayPathUnderHome("/opt/other")).toBe("/opt/other");
	});
});
