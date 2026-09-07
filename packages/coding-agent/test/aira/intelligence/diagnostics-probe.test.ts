import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { type AiraIntelligenceHandle, createAiraIntelligence } from "../../../src/aira/intelligence/coordinator.ts";
import { createAiraIntelligenceToolDefinitions } from "../../../src/aira/intelligence/model-tools.ts";
import {
	commandOnPath,
	resolveLaunchSpec,
	serverForLanguage,
} from "../../../src/aira/intelligence/providers/live-code/registry.ts";
import { resolveAiraProjectInto } from "../../../src/aira/project/index.ts";
import { type AiraSessionState, acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { decorateAiraIntelligenceRenderers } from "../../../src/core/tools/aira-intelligence-renderers.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

/**
 * Focused real-language-server validation for the model-facing diagnostics
 * surface. Skips truthfully when no TypeScript server (plus a reachable
 * `typescript` installation) exists; when it runs, it proves the LSP path end
 * to end: cold start, genuine TS2322 payload with the real message and
 * location, clearing on fix.
 *
 * No compiler/build/test command is ever executed — only the language server
 * (spawned by the live-code provider) produces the diagnostics.
 */

// typescript-language-server needs a reachable `typescript` install; the test
// process resolves the one this repo provides, and the temp project symlinks
// it under its own node_modules (the registry's discovery strategy; the
// repository scanner prunes node_modules and skips symlinks).
let typescriptRoot: string | undefined;
try {
	// `resolve` returns an absolute filesystem path, not a URL.
	typescriptRoot = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
} catch {
	typescriptRoot = undefined;
}

const hasTypeScriptServer =
	(commandOnPath("typescript-language-server") ||
		resolveLaunchSpec(serverForLanguage("typescript")!, undefined) !== undefined) &&
	typescriptRoot !== undefined;

const PROBE_CONTENT = "const airaDiagnosticProbe: string = 123;\nexport { airaDiagnosticProbe };\n";

const activeHarnesses: Array<{ state: AiraSessionState; handle: AiraIntelligenceHandle }> = [];

afterEach(async () => {
	for (const entry of activeHarnesses.splice(0)) {
		await entry.handle.dispose();
		disposeAiraSessionState(entry.state.sessionId, entry.state);
	}
});

function makeProbeProject(name: string): string {
	const root = join(tmpdir(), `aira-probe-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, ".git"));
	if (typescriptRoot) {
		mkdirSync(join(root, "node_modules"), { recursive: true });
		try {
			symlinkSync(typescriptRoot, join(root, "node_modules", "typescript"), "junction");
		} catch {
			// Best-effort: the server then falls back to its own resolution.
		}
	}
	writeFileSync(join(root, "package.json"), JSON.stringify({ name, private: true }));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, "src", "probe.ts"), PROBE_CONTENT);
	return root;
}

function projectState(root: string): AiraSessionState {
	const state = acquireAiraSessionState(`probe-${root.split("-").at(-1)}`, "startup");
	resolveAiraProjectInto(state, root);
	return state;
}

describe(
	"language-server diagnostics surface (real TS server)",
	{ skip: !hasTypeScriptServer, timeout: 60_000 },
	() => {
		it("cold-starts the LSP and returns the genuine type error for the probe file", { timeout: 60_000 }, async () => {
			const root = makeProbeProject("ts2322");
			const probe = join(root, "src", "probe.ts");
			const state = projectState(root);
			const handle = createAiraIntelligence(state, undefined, {
				cacheDir: join(tmpdir(), "probe-cache"),
				// The real server is resolved from PATH; give the cold-start
				// publish a generous but bounded budget.
				diagnosticsQueryWaitMs: 20_000,
			});
			activeHarnesses.push({ state, handle });
			await handle.activate();
			await handle.waitUntilSettled();

			const result = await handle.diagnostics({ paths: ["src/probe.ts"] });
			expect(result.status).toBe("ready");
			const file = result.files.find((entry) => entry.path === "src/probe.ts");
			expect(file?.status).toBe("ready");
			const error = file?.diagnostics.find((entry) => entry.severity === "error");
			expect(error).toBeDefined();
			expect(error?.message).toContain("not assignable");
			expect(String(error?.code)).toBe("2322");
			expect(error?.line).toBe(1);
			expect(error?.character).toBeGreaterThan(0);
			expect(error?.character).toBeLessThanOrEqual(40);
			expect(result.totals.errors).toBeGreaterThanOrEqual(1);

			// Engineering Context / Workbench state reflects the count.
			expect(state.intelligence?.findings.errors).toBeGreaterThanOrEqual(1);
			const context = handle.providePromptContext("check the probe file");
			expect(context).toContain("Diagnostics");

			// Fixing the file clears the diagnostic state.
			writeFileSync(probe, 'export const airaDiagnosticProbe: string = "ok";\n');
			const fixed = await handle.diagnostics({ paths: ["src/probe.ts"] });
			const fixedFile = fixed.files.find((entry) => entry.path === "src/probe.ts");
			expect(fixedFile?.status).toBe("ready");
			expect(fixedFile?.diagnostics).toEqual([]);
			expect(fixed.totals.errors + fixed.totals.warnings).toBe(0);
			expect(state.intelligence?.findings.errors).toBe(0);

			// Live-code health: one spawned server, no crashes.
			expect(state.intelligence?.liveCode.spawnCount).toBe(1);
			expect(state.intelligence?.liveCode.crashCount).toBe(0);
		});

		it(
			"dogfood: the real diagnostics payload renders polished in the conversation",
			{ timeout: 60_000 },
			async () => {
				const root = makeProbeProject("rendered");
				const state = projectState(root);
				const handle = createAiraIntelligence(state, undefined, {
					cacheDir: join(tmpdir(), "probe-cache-rendered"),
					diagnosticsQueryWaitMs: 20_000,
				});
				activeHarnesses.push({ state, handle });
				await handle.activate();
				await handle.waitUntilSettled();

				const payload = await handle.diagnostics({ paths: ["src/probe.ts"] });
				expect(payload.status).toBe("ready");
				const file = payload.files.find((entry) => entry.path === "src/probe.ts");
				expect(file?.diagnostics[0]?.severity).toBe("error");

				// The human conversation renders the REAL structured payload
				// through the presentation layer. The model-facing content and
				// details remain the raw JSON object.
				initTheme("dark");
				const definitions = decorateAiraIntelligenceRenderers(
					createAiraIntelligenceToolDefinitions({ runtime: handle }),
				);
				const result = await (
					definitions.aira_diagnostics.execute as (
						id: string,
						params: { paths: string[] },
					) => Promise<{
						content: Array<{ type: string; text: string }>;
						details: unknown;
					}>
				)("dogfood-call", { paths: ["src/probe.ts"] });
				expect(result.details).toEqual(payload);
				expect(result.content[0].text).toBe(JSON.stringify(payload));

				const component = new ToolExecutionComponent(
					"aira_diagnostics",
					"dogfood-call",
					{ paths: ["src/probe.ts"] },
					{},
					definitions.aira_diagnostics,
					{ requestRender: () => {} } as unknown as TUI,
					root,
				);
				component.markExecutionStarted();
				component.updateResult({ ...result, isError: false });
				const lines = stripAnsi(component.render(120).join("\n")).split("\n");

				// Polished compact view — no raw JSON dump.
				expect(lines[0]).toContain("✓");
				expect(lines[0]).toContain("Diagnostics");
				expect(lines[0]).toContain("src/probe.ts");
				expect(lines[0]).toContain("1 error");
				expect(lines[1]).toContain("2322 · 1:7");
				expect(lines[2]).toContain("Type 'number' is not assignable to type 'string'.");
				expect(lines.join("\n")).not.toContain('"status"');
				expect(lines.join("\n")).not.toContain('"diagnostics"');
			},
		);
	},
);
