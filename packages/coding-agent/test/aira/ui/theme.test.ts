import { describe, expect, it } from "vitest";
import {
	getAvailableThemesWithPaths,
	getDefaultTheme,
	getThemeByName,
} from "../../../src/modes/interactive/theme/theme.ts";

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
});
