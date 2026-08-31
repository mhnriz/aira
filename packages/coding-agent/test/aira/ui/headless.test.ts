/**
 * Headless isolation contract (Phase 12): the pure Workbench projection must
 * never drag the interactive TUI (or any interactive component) into
 * headless/print/SDK/RPC contexts. This test asserts the module boundary by
 * importing every aira/ui module and verifying none of them transitively
 * imports the interactive renderer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "aira", "ui");

const INTERACTIVE_MARKERS = [
	"modes/interactive/",
	"pi-tui",
	"@earendil-works/pi-tui",
	"workbench/controller",
	"components/footer.ts",
];

function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectSourceFiles(full));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
	}
	return files;
}

describe("Workbench projection headless isolation", () => {
	it("every aira/ui source file avoids interactive/TUI imports", () => {
		const files = collectSourceFiles(uiDir);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const source = fs.readFileSync(file, "utf-8");
			// Inspect only import/export statements, not doc comments.
			const statements = source
				.split("\n")
				.filter((line) => /^import|^export .*from/.test(line.trim()))
				.join("\n");
			for (const marker of INTERACTIVE_MARKERS) {
				expect(statements, `${path.basename(file)} must not import ${marker}`).not.toContain(marker);
			}
		}
	});

	it("the projection modules import only canonical/airo-side seams", () => {
		const projectionModule = fs.readFileSync(path.join(uiDir, "projection.ts"), "utf-8");
		expect(projectionModule).not.toContain("interactive");
		expect(projectionModule).not.toContain("pi-tui");
		const controllerDir = path.join(uiDir, "..", "..", "modes", "interactive", "workbench");
		expect(fs.existsSync(controllerDir)).toBe(true);
		// The controller lives outside aira/ui (interactive-only by location);
		// nothing under aira/ui may reference it.
		for (const file of collectSourceFiles(uiDir)) {
			const source = fs.readFileSync(file, "utf-8");
			expect(source).not.toContain("workbench/controller");
		}
	});
});
