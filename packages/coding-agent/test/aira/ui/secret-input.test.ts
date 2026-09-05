import { beforeAll, describe, expect, it } from "vitest";
import { SecretInputComponent } from "../../../src/modes/interactive/components/secret-input.ts";
import { setTheme } from "../../../src/modes/interactive/theme/theme.ts";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

describe("Aira secret input", () => {
	beforeAll(() => {
		expect(setTheme("aira-zhr").success).toBe(true);
	});

	it("masks local input and clears it before the callback returns", () => {
		let submitted: string | undefined;
		const component = new SecretInputComponent(
			{ requestRender: () => {} } as never,
			"sudo password",
			(value) => {
				submitted = value;
			},
			() => {},
		);

		component.handleInput("s");
		component.handleInput("e");
		const masked = component.render(60).join("\n").replace(ANSI, "");
		expect(masked).toContain("••");
		expect(masked).not.toContain("se");

		component.handleInput("\n");
		expect(submitted).toBe("se");
		const cleared = component.render(60).join("\n").replace(ANSI, "");
		expect(cleared).not.toContain("se");
		component.dispose();
	});

	it("cancels without returning input", () => {
		let cancelled = 0;
		let submitted = 0;
		const component = new SecretInputComponent(
			{ requestRender: () => {} } as never,
			"sudo password",
			() => {
				submitted += 1;
			},
			() => {
				cancelled += 1;
			},
		);
		component.handleInput("s");
		component.handleInput("\x1b");
		expect(cancelled).toBe(1);
		expect(submitted).toBe(0);
		component.dispose();
	});
});
