import { describe, expect, it } from "vitest";
import {
	getAvailableThemesWithPaths,
	getDefaultTheme,
	getResolvedThemeColors,
	getThemeByName,
} from "../../../src/modes/interactive/theme/theme.ts";

/** Resolved hex of a color token from the theme file (mode-independent). */
function tokenHex(themeName: string, token: string): string {
	const hex = getResolvedThemeColors(themeName)[token];
	if (!hex) throw new Error(`Token ${token} missing from ${themeName}`);
	return hex.toLowerCase();
}

describe("Aira theme (aira-zhr) semantic contract", () => {
	it("ships aira-zhr as a built-in theme", () => {
		const names = getAvailableThemesWithPaths().map((info) => info.name);
		expect(names).toContain("aira-zhr");
	});

	it("resolves to a valid theme with the Phase 12 semantic roles", () => {
		const airaZhr = getThemeByName("aira-zhr");
		expect(airaZhr).toBeDefined();
		expect(airaZhr!.name).toBe("aira-zhr");
		for (const role of ["copper", "copperBright", "blue", "cyan", "green", "yellow", "red", "purple"] as const) {
			expect(() => airaZhr!.getFgAnsi(role)).not.toThrow();
		}
	});

	it("maps copper to the Aira identity accent (distinct from classic accent where defined)", () => {
		const airaZhr = getThemeByName("aira-zhr");
		// In aira-zhr, accent IS copper ("accent": "copper").
		expect(airaZhr!.getFgAnsi("accent")).toBe(airaZhr!.getFgAnsi("copper"));
		expect(airaZhr!.getFgAnsi("green")).toBe(airaZhr!.getFgAnsi("success"));
		expect(airaZhr!.getFgAnsi("yellow")).toBe(airaZhr!.getFgAnsi("warning"));
		expect(airaZhr!.getFgAnsi("red")).toBe(airaZhr!.getFgAnsi("error"));
	});

	it("classic themes keep working without the new roles (fallback semantics)", () => {
		const dark = getThemeByName("dark");
		expect(dark).toBeDefined();
		// Fallbacks resolve even though dark.json does not define the roles.
		expect(dark!.getFgAnsi("copper")).toBe(dark!.getFgAnsi("accent"));
		expect(dark!.getFgAnsi("green")).toBe(dark!.getFgAnsi("success"));
		expect(dark!.getFgAnsi("red")).toBe(dark!.getFgAnsi("error"));
		expect(dark!.getFgAnsi("yellow")).toBe(dark!.getFgAnsi("warning"));
	});

	it("light theme also ships the semantic roles", () => {
		const light = getThemeByName("light");
		expect(light).toBeDefined();
		for (const role of ["copper", "blue", "cyan", "green", "yellow", "red", "purple"] as const) {
			expect(() => light!.getFgAnsi(role)).not.toThrow();
		}
	});

	it("is the default dark-theme resolution (unset setting)", () => {
		// getDefaultTheme() returns aira-zhr for dark terminals; light stays light.
		expect(["aira-zhr", "light"]).toContain(getDefaultTheme());
	});

	it("resolves aira-zhr to the background-independent warm-neutral semantic palette", () => {
		expect(tokenHex("aira-zhr", "copper")).toBe("#d89a72");
		expect(tokenHex("aira-zhr", "accent")).toBe("#d89a72"); // accent IS copper
		expect(tokenHex("aira-zhr", "blue")).toBe("#7895bc"); // muted blue / info / LSP
		expect(tokenHex("aira-zhr", "cyan")).toBe("#a9bbd3"); // soft blue / active agents
		expect(tokenHex("aira-zhr", "green")).toBe("#82b792");
		expect(tokenHex("aira-zhr", "yellow")).toBe("#d6aa6c");
		expect(tokenHex("aira-zhr", "red")).toBe("#d77c78");
		expect(tokenHex("aira-zhr", "text")).toBe("#e7e1d9"); // warm ivory
		expect(tokenHex("aira-zhr", "muted")).toBe("#8f8c89"); // taupe
		expect(tokenHex("aira-zhr", "border")).toBe("#66574f");
		expect(tokenHex("aira-zhr", "success")).toBe("#82b792");
		expect(tokenHex("aira-zhr", "warning")).toBe("#d6aa6c");
		expect(tokenHex("aira-zhr", "error")).toBe("#d77c78");
		// Focused border reuses the copper accent (semantic, not a new literal).
		expect(tokenHex("aira-zhr", "copperBright")).toBe("#e0ac82");
	});

	it("keeps the semantic roles distinguishable and restrained", () => {
		const copper = tokenHex("aira-zhr", "copper");
		const blue = tokenHex("aira-zhr", "blue");
		const cyan = tokenHex("aira-zhr", "cyan");
		const muted = tokenHex("aira-zhr", "muted");
		expect(copper).not.toBe(blue);
		expect(blue).not.toBe(cyan);
		expect(muted).not.toBe(copper);
	});

	it("keeps aira-zhr background tokens warm-neutral without imposing a chrome fill", () => {
		const theme = getThemeByName("aira-zhr")!;
		// All paint that Aira still owns (selection, search, tool boxes) stays
		// defined; the composer/footer lanes no longer consume them as fills.
		for (const bg of ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg"] as const) {
			expect(() => theme.getBgAnsi(bg)).not.toThrow();
		}
	});
});
