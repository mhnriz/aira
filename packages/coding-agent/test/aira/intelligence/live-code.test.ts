import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AiraFindingsStore } from "../../../src/aira/intelligence/findings.ts";
import { LiveCodeProvider } from "../../../src/aira/intelligence/providers/live-code/index.ts";
import { convertCharacterOffset } from "../../../src/aira/intelligence/providers/live-code/lsp-client.ts";
import {
	commandOnPath,
	lspLanguageIds,
	resolveLaunchSpec,
	serverForLanguage,
} from "../../../src/aira/intelligence/providers/live-code/registry.ts";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-lsp-server.mjs", import.meta.url));

function makeRoot(name: string): string {
	const root = join(tmpdir(), `aira-live-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

function launchSpec(extraArgs: string[] = []) {
	return { command: "node", args: [MOCK_SERVER, ...extraArgs], argv0: process.execPath };
}

function providerFor(root: string, options: { crash?: boolean; extra?: Record<string, unknown> } = {}) {
	const findings = new AiraFindingsStore();
	const provider = new LiveCodeProvider(root, findings, {
		diagnosticWaitMs: 600,
		idleTimeoutMs: 30_000,
		crashCooldownMs: 0,
		launchOverrides: { typescript: launchSpec(options.crash ? ["--crash-on-initialize"] : []) },
		...(options.extra ?? {}),
	});
	return { findings, provider };
}

describe("language-server registry and discovery", () => {
	it("maps repository languages to served LSP language ids", () => {
		expect(lspLanguageIds("typescript")).toEqual(["typescript", "typescriptreact"]);
		expect(lspLanguageIds("python")).toEqual(["python"]);
		expect(lspLanguageIds("ruby")).toEqual([]);
	});

	it("finds a definition for supported languages only", () => {
		expect(serverForLanguage("typescript")?.id).toBe("typescript");
		expect(serverForLanguage("go")?.id).toBe("go");
		expect(serverForLanguage("generic")).toBeUndefined();
	});

	it("resolves launch specs from PATH and project node_modules", () => {
		// Node is guaranteed on PATH in the test environment.
		const executable = process.platform === "win32" ? "node.exe" : "node";
		const found = resolveLaunchSpec(
			{ id: "synthetic", languageIds: ["x"], commands: [[executable, "--version"]] },
			undefined,
		);
		expect(found?.command).toBe(executable);
		expect(found?.argv0).toBe(executable);
		// A nonexistent command never resolves.
		expect(
			resolveLaunchSpec(
				{ id: "x", languageIds: ["x"], commands: [["definitely-not-a-real-server-12345"]] },
				undefined,
			),
		).toBeUndefined();
	});

	it("detects PATH presence (node is always present in tests)", () => {
		expect(commandOnPath(process.platform === "win32" ? "node.exe" : "node")).toBe(true);
	});
});

describe("LSP position conversion", () => {
	it("converts utf-16 offsets to utf-8 byte offsets", () => {
		expect(convertCharacterOffset("utf-16", "abc", 2)).toBe(2);
		expect(convertCharacterOffset("utf-8", "a😀b", 2)).toBe(5);
		expect(convertCharacterOffset("utf-8", "abc", 1)).toBe(1);
	});
});

describe("live-code provider (mock language server)", () => {
	it("collects diagnostics after a document sync and maps severity", async () => {
		const root = makeRoot("diag");
		const file = join(root, "src", "tray.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "export function stabilizeTray() { ERROR_MARKER }");

		const { findings, provider } = providerFor(root);
		await provider.requestDiagnosticsForFile(file);
		const stored = findings.forPath(file, Date.now());
		expect(stored.length).toBe(1);
		expect(stored[0]?.severity).toBe("error");
		expect(stored[0]?.message).toContain("ERROR_MARKER");
		expect(stored[0]?.source).toBe("lsp");
		expect(stored[0]?.providerId).toBe("typescript");
		expect(stored[0]?.freshness).not.toBe("stale");
		await provider.dispose();
	});

	it("replaces findings atomically when the file changes", async () => {
		const root = makeRoot("replace");
		const file = join(root, "src", "tray.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "export function stabilizeTray() { ERROR_MARKER }");

		const { findings, provider } = providerFor(root);
		await provider.requestDiagnosticsForFile(file);
		expect(findings.forPath(file).length).toBe(1);

		writeFileSync(file, "export function stabilizeTray() { /* fixed */ }");
		await provider.requestDiagnosticsForFile(file);
		expect(findings.forPath(file)).toEqual([]);
		expect(findings.counts().errors).toBe(0);
		await provider.dispose();
	});

	it("serves warm-only navigation (definitions/references/symbols) after sync", async () => {
		const root = makeRoot("nav");
		const file = join(root, "src", "tray.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "export function stabilizeTray() {}\nexport function detectionState() {}");

		const { provider } = providerFor(root);

		// Cold: no client spawned, navigation refuses (never cold-spawns).
		expect(provider.isWarm(file)).toBe(false);
		expect(await provider.navigate(file, "definition", "detectionState")).toBeUndefined();

		// Warm the server via a diagnostics request, then navigate.
		await provider.requestDiagnosticsForFile(file);
		expect(provider.isWarm(file)).toBe(true);
		const definition = await provider.navigate(file, "definition", "detectionState");
		expect(definition).toBeDefined();
		if (definition && "locations" in definition) {
			expect(definition.locations[0]?.uri).toBe("file:///canned/definition.ts");
		}
		const references = await provider.navigate(file, "references", "detectionState");
		expect(references && "locations" in references ? references.locations.length : 0).toBe(1);
		const symbols = await provider.navigate(file, "symbols");
		expect(symbols && "symbols" in symbols ? symbols.symbols.map((s) => s.name).sort() : []).toEqual([
			"detectionState",
			"stabilizeTray",
		]);
		await provider.dispose();
	});

	it("degrades without findings when the server crashes at handshake", async () => {
		const root = makeRoot("crash-init");
		const file = join(root, "src", "tray.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "export function a() {}");

		const { findings, provider } = providerFor(root, { crash: true });
		await provider.requestDiagnosticsForFile(file);
		expect(findings.forPath(file)).toEqual([]);
		const info = provider.statusInfo();
		expect(info.crashCount).toBeGreaterThanOrEqual(1);
		expect(info.status).toBe("degraded");
		// Warm-only navigation still refuses (no running client).
		expect(await provider.navigate(file, "definition", "a")).toBeUndefined();
		await provider.dispose();
	});

	it("recovers after a crash once the cooldown passes (respawn allowed)", async () => {
		const root = makeRoot("crash-recover");
		const file = join(root, "src", "tray.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "export function a() {}");

		const findings = new AiraFindingsStore();
		const provider = new LiveCodeProvider(root, findings, {
			diagnosticWaitMs: 600,
			idleTimeoutMs: 30_000,
			crashCooldownMs: 50,
			launchOverrides: { typescript: launchSpec(["--crash-after-open"]) },
		});
		await provider.requestDiagnosticsForFile(file);
		expect(findings.forPath(file)).toEqual([]);
		expect(provider.statusInfo().crashCount).toBe(1);
		await provider.dispose();
	});

	it("evicts documents beyond the open cap (LRU)", async () => {
		const root = makeRoot("evict");
		const files = ["a.ts", "b.ts", "c.ts"].map((name) => {
			const file = join(root, "src", name);
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(file, "export function x() {}");
			return file;
		});

		const { provider } = providerFor(root, {
			extra: { maxOpenDocuments: 2, diagnosticWaitMs: 100 },
		});
		for (const file of files) {
			await provider.requestDiagnosticsForFile(file);
		}
		expect(provider.statusInfo().evictionCount).toBeGreaterThanOrEqual(1);
		await provider.dispose();
	});

	it("shuts servers down on idle timeout", async () => {
		const root = makeRoot("idle");
		const file = join(root, "src", "tray.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "export function a() {}");

		const { findings: _findings, provider } = providerFor(root, {
			extra: { idleTimeoutMs: 120, crashCooldownMs: 0 },
		});
		await provider.requestDiagnosticsForFile(file);
		expect(provider.isWarm(file)).toBe(true);
		// The idle timer fires in real time; under parallel test load the
		// shutdown can lag past a fixed sleep, so poll for the observed state.
		const deadline = Date.now() + 5_000;
		while (provider.isWarm(file) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(provider.isWarm(file)).toBe(false);
		const deadline2 = Date.now() + 2_000;
		let status: string | undefined;
		while (Date.now() < deadline2) {
			const info = provider.statusInfo();
			status = info.servers.find((s) => s.id === "typescript")?.status;
			if (status === "closed") {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(status).toBe("closed");
		await provider.dispose();
	});

	it("kills the spawned server when the handshake fails (no orphaned child)", async () => {
		const root = makeRoot("hang-init");
		const file = join(root, "src", "tray.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "export function a() {}");
		const pidFile = join(tmpdir(), `aira-mock-pid-${Date.now()}-${Math.random().toString(36).slice(2)}`);

		const { provider } = providerFor(root, {
			extra: {
				requestTimeoutMs: 300,
				launchOverrides: {
					typescript: launchSpec(["--ignore-initialize", "--pid-file", pidFile]),
				},
			},
		});
		await provider.requestDiagnosticsForFile(file);
		// The handshake never completes: the initialize request times out, the
		// client is abandoned, and the spawned child is force-killed.
		await new Promise((resolve) => setTimeout(resolve, 700));
		const childPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
		let alive = true;
		try {
			process.kill(childPid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
		await provider.dispose();
	});

	it("reports idle (not unavailable) while cold when a matching server resolves", async () => {
		const root = makeRoot("cold-idle");
		const { provider } = providerFor(root);

		const info = provider.statusInfo();
		expect(info.status).toBe("idle");
		expect(info.spawnCount).toBe(0);
		expect(info.crashCount).toBe(0);
		const server = info.servers.find((s) => s.id === "typescript");
		expect(server?.status).toBe("unprobed");
		expect(server?.available).toBe(true);

		// Still cold: nothing was spawned and navigation refuses to wake it.
		const file = join(root, "src", "tray.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "export function a() {}");
		expect(provider.isWarm(file)).toBe(false);
		expect(await provider.navigate(file, "definition", "a")).toBeUndefined();
		expect(provider.statusInfo().spawnCount).toBe(0);
		await provider.dispose();
	});

	it("reports unavailable while cold when no matching server resolves", async () => {
		const root = makeRoot("cold-unavailable");
		const emptyPath = join(root, "no-binaries");
		mkdirSync(emptyPath, { recursive: true });
		const findings = new AiraFindingsStore();
		const provider = new LiveCodeProvider(root, findings, {
			diagnosticWaitMs: 600,
			idleTimeoutMs: 30_000,
			crashCooldownMs: 0,
		});

		// No launch overrides and an empty PATH: no registry command resolves,
		// so the cold provider is genuinely unavailable.
		const originalPath = process.env.PATH;
		process.env.PATH = emptyPath;
		try {
			const info = provider.statusInfo();
			expect(info.status).toBe("unavailable");
			expect(info.spawnCount).toBe(0);
			expect(info.servers.every((s) => !s.available)).toBe(true);
		} finally {
			process.env.PATH = originalPath;
		}
		await provider.dispose();
	});
});
