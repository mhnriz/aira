import { type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";

const BG_ESCAPE = /\x1b\[48/;

/** Active theme escapes for the two frame states (copper / borderMuted). */
function frameEscapes(): { copper: string; borderMuted: string } {
	return { copper: theme.getFgAnsi("copper"), borderMuted: theme.getFgAnsi("borderMuted") };
}

function fakeTerminal(columns = 80, rows = 24): Terminal {
	return { columns, rows } as unknown as Terminal;
}

describe("Aira composer visual treatment (aira-zhr)", () => {
	beforeAll(() => {
		initTheme("aira-zhr", false);
	});

	function renderEditor(focused: boolean): string[] {
		const tui = { terminal: fakeTerminal(), requestRender: () => {} } as never;
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
		editor.focused = focused;
		return editor.render(72);
	}

	it("no longer paints the old gray input-lane fill", () => {
		const lines = renderEditor(true);
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines) {
			expect(line).not.toMatch(BG_ESCAPE);
		}
	});

	it("keeps the frame shape, width stability, and COMPOSE label", () => {
		const lines = renderEditor(true);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
		expect(plain[0]).toContain("COMPOSE");
		expect(plain[1]).toMatch(/^│.*│$/);
		expect(plain.at(-1)).toContain("send");
		expect(plain.at(-1)).toContain("/ commands");
		for (const line of lines) expect(visibleWidth(line)).toBe(72);
	});

	it("draws the frame edge in copper while focused and muted-subtle while idle", () => {
		const { copper, borderMuted } = frameEscapes();
		// Focused: the input row edges and bottom frame use the copper accent.
		const focused = renderEditor(true);
		for (const line of focused.slice(1)) {
			expect(line).toContain(copper);
		}
		// Idle: the input row edges and bottom frame use the subtle border;
		// only the COMPOSE label keeps the copper accent.
		const idle = renderEditor(false);
		expect(idle[1]).not.toContain(copper);
		expect(idle[1]).toContain(borderMuted);
		expect(idle.at(-1)).not.toContain(copper);
		expect(idle.at(-1)).toContain(borderMuted);
		expect(idle[0]).toContain(copper); // label only
	});
});
