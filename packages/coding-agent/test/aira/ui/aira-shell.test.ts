import { type Terminal, Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { AiraHeaderComponent, AiraNoticeComponent } from "../../../src/modes/interactive/components/aira-shell.ts";
import { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { AiraTuiMainScreen } from "../../../src/modes/interactive/workbench/tui-rail.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

function fakeTerminal(columns = 80, rows = 24): Terminal {
	return { columns, rows } as unknown as Terminal;
}

describe("Aira application shell", () => {
	beforeAll(() => {
		initTheme("aira-zhr", false);
	});

	it("renders a restrained product header without stock Pi onboarding", () => {
		const header = new AiraHeaderComponent(() => ({
			mode: "build",
			cwd: "~/proj/aira",
			branch: "main",
			model: "deepseek-v4-flash",
			thinking: "max",
			session: "LOCAL",
			controls: "ctrl+o details · ctrl+shift+o Workbench",
		}));
		const rendered = header.render(90).map(stripAnsi);

		expect(rendered).toHaveLength(3);
		expect(rendered[0]).toContain("AIRA WORKBENCH");
		expect(rendered[0]).toContain("BUILD");
		expect(rendered[1]).toContain("~/proj/aira · main");
		expect(rendered[1]).toContain("deepseek-v4-flash · max");
		expect(rendered.join("\n")).not.toContain("Pi can");
	});

	it("frames the existing editor behavior as an Aira composer", () => {
		const tui = { terminal: fakeTerminal(80, 24), requestRender: () => {} } as never;
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
		const lines = editor.render(72);
		const plain = lines.map(stripAnsi);

		expect(plain[0]).toContain("COMPOSE");
		expect(plain[1]).toMatch(/^│.*│$/);
		expect(plain.at(-1)).toContain("send");
		expect(plain.at(-1)).toContain("/ commands");
		for (const line of lines) expect(visibleWidth(line)).toBe(72);
	});

	it("uses compact Aira-native transcript notices", () => {
		const line = stripAnsi(new AiraNoticeComponent("Model catalog ready", "status").render(50)[0]!);
		expect(line).toContain("· AIRA Model catalog ready");
		expect(line).not.toContain("[Context]");
	});

	it("anchors the dock and footer when the transcript is sparse", () => {
		const terminal = fakeTerminal(40, 8);
		const screen = new AiraTuiMainScreen(terminal, false, "/tmp");
		const header = new Text("header", 0, 0);
		const dock = new Text("dock", 0, 0);
		const footer = new Text("footer", 0, 0);
		screen.addChild(header);
		screen.addChild(dock);
		screen.addChild(footer);
		screen.setSidebarRail({
			rail: new Text("rail", 0, 0),
			getWidth: () => 10,
			fullWidthChildren: [footer],
			dockAnchor: dock,
		});

		const lines = screen.render(40).map(stripAnsi);
		expect(lines).toHaveLength(8);
		expect(lines[6]).toContain("dock");
		expect(lines[7]).toContain("footer");
		expect(screen.footerStartRow).toBe(7);
	});
});
