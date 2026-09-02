import { HStack, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import {
	AiraConversationTitleComponent,
	AiraNewOutputIndicatorComponent,
} from "../../src/modes/interactive/components/aira-shell.ts";
import { setTheme } from "../../src/modes/interactive/theme/theme.ts";
import {
	renderWorkbenchTitle,
	WorkbenchTitleComponent,
} from "../../src/modes/interactive/workbench/workbench-component.ts";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function plain(text: string): string {
	return text.replace(ANSI, "");
}

describe("Aira native multi-pane viewports (Phase 12.1)", () => {
	it("conversation title shows a focus mark only while the conversation is focused", () => {
		const title = new AiraConversationTitleComponent(() => true);
		expect(plain(title.render(40)[0] ?? "")).toContain("CONVERSATION");
		expect(plain(title.render(40)[0] ?? "")).toContain("●");

		const unfocused = new AiraConversationTitleComponent(() => false);
		expect(plain(unfocused.render(40)[0] ?? "")).not.toContain("●");
	});

	it("workbench title flips to LIVE STATE · VIEWING HISTORY when the transcript reads history", () => {
		expect(plain(renderWorkbenchTitle(40, { focused: false, viewingHistory: false })[1] ?? "")).toContain(
			"CANONICAL STATE · TOKEN-FREE",
		);
		expect(plain(renderWorkbenchTitle(40, { focused: true, viewingHistory: false })[0] ?? "")).toContain(
			"ENGINEERING CONTEXT",
		);
		expect(plain(renderWorkbenchTitle(40, { focused: false, viewingHistory: true })[1] ?? "")).toContain(
			"LIVE STATE · VIEWING HISTORY",
		);
		expect(plain(renderWorkbenchTitle(40, { focused: true, viewingHistory: true })[0] ?? "")).toContain("●");
	});

	it("new-output indicator renders nothing at the live bottom and a line when unread", () => {
		const indicator = new AiraNewOutputIndicatorComponent(() => 0);
		expect(indicator.render(40)).toEqual([]);

		const live = new AiraNewOutputIndicatorComponent(() => 24);
		expect(plain(live.render(40)[0] ?? "")).toContain("↓ 24 new lines");
		expect(plain(new AiraNewOutputIndicatorComponent(() => 1).render(40)[0] ?? "")).toContain("↓ 1 new line");
	});

	it("keeps the shell fixed and scrolls panes independently with keyboard focus targeting", async () => {
		const terminal = new VirtualTerminal(80, 20);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(Array.from({ length: 30 }, (_, index) => `t${index + 1}`).join("\n"), 0, 0);
		const workbenchText = new Text(Array.from({ length: 40 }, (_, index) => `w${index + 1}`).join("\n"), 0, 0);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const workbench = new ScrollView(workbenchText, { follow: "none", primary: false });

		let focus = "conversation";
		const conversationTitle = new AiraConversationTitleComponent(() => focus !== "workbench");
		const workbenchTitle = new WorkbenchTitleComponent(() => ({
			focused: focus === "workbench",
			viewingHistory: !transcript.isFollowingEnd,
		}));

		const conversationColumn = new VStack([
			{ component: conversationTitle, basis: "auto", grow: 0, minSize: 1 },
			{ component: transcript, basis: 0, grow: 1, minSize: 1 },
			{ component: new AiraNewOutputIndicatorComponent(() => transcript.getUnreadLines()), basis: "auto", grow: 0 },
		]);
		const workbenchColumn = new VStack([
			{ component: workbenchTitle, basis: "auto", grow: 0, minSize: 1 },
			{ component: workbench, basis: 0, grow: 1, minSize: 1 },
		]);
		tui.setLayoutRoot(
			new VStack([
				{ component: new Text("HEADER", 0, 0), basis: "auto", grow: 0 },
				{
					component: new HStack([
						{ component: conversationColumn, basis: 0, grow: 1, minSize: 30 },
						{ component: workbenchColumn, basis: 42, grow: 0, shrink: 0 },
					]),
					basis: 0,
					grow: 1,
					minSize: 1,
				},
				{ component: new Text("FOOTER", 0, 0), basis: "auto", grow: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		// Both panes follow independently; the shell rows stay put.
		assertVisible(terminal, 0, "HEADER");
		assertVisible(terminal, 19, "FOOTER");

		// Wheel over the transcript (x=10) scrolls the transcript only. The
		// Workbench (follow: none) starts at its top and stays put.
		terminal.sendInput("\x1b[<64;10;2M");
		await terminal.waitForRender();
		expect(transcript.scrollTop).toBeLessThan(30 - 16);
		expect(workbench.scrollTop).toBe(0);

		// Keyboard focus: conversation by default, PageUp targets the transcript.
		const conversationBefore = transcript.scrollTop;
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		expect(transcript.scrollTop).toBeLessThan(conversationBefore);
		const conversationAfterPage = transcript.scrollTop;

		// Focus the workbench: keyboard navigation now targets the workbench,
		// not the transcript. (follow:none starts at the top, so PageDown first.)
		focus = "workbench";
		tui.setKeyboardScrollTarget(workbench);
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		const workbenchBefore = workbench.scrollTop;
		expect(workbenchBefore).toBeGreaterThan(0);
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		expect(workbench.scrollTop).toBeLessThan(workbenchBefore);
		expect(transcript.scrollTop).toBe(conversationAfterPage);

		// The focus mark moved to the Workbench title (conversation column is
		// 38 cols wide; the Workbench title lives at the end of the same row).
		const rows = terminal.getViewport().map(plain);
		expect(rows.some((line) => line.includes("ENGINEERING CONTEXT") && line.includes("●"))).toBe(true);
		expect(rows.some((line) => line.startsWith("CONVERSATION") && line.slice(0, 38).includes("●"))).toBe(false);
		tui.stop();
	});

	it("shows the new-output indicator and live/history label while reading history, cleared on End", async () => {
		const terminal = new VirtualTerminal(80, 20);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(Array.from({ length: 30 }, (_, index) => `t${index + 1}`).join("\n"), 0, 0);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const workbenchText = new Text("w1\nw2\nw3", 0, 0);
		const workbench = new ScrollView(workbenchText, { follow: "none", primary: false });
		const workbenchTitle = new WorkbenchTitleComponent(() => ({
			focused: false,
			viewingHistory: !transcript.isFollowingEnd,
		}));

		const conversationColumn = new VStack([
			{ component: transcript, basis: 0, grow: 1, minSize: 1 },
			{ component: new AiraNewOutputIndicatorComponent(() => transcript.getUnreadLines()), basis: "auto", grow: 0 },
		]);
		const workbenchColumn = new VStack([
			{ component: workbenchTitle, basis: "auto", grow: 0, minSize: 1 },
			{ component: workbench, basis: 0, grow: 1, minSize: 1 },
		]);
		tui.setLayoutRoot(
			new HStack([
				{ component: conversationColumn, basis: 0, grow: 1, minSize: 30 },
				{ component: workbenchColumn, basis: 42, grow: 0, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		// At the live bottom: canonical label, no indicator.
		let rows = terminal.getViewport().map(plain);
		expect(rows.some((line) => line.includes("CANONICAL STATE · TOKEN-FREE"))).toBe(true);
		expect(rows.some((line) => line.includes("↓ "))).toBe(false);

		// Scroll up a full page: history posture.
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		rows = terminal.getViewport().map(plain);
		expect(rows.some((line) => line.includes("LIVE STATE · VIEWING HISTORY"))).toBe(true);
		expect(rows.some((line) => /↓ \d+ new lines/.test(line))).toBe(true);

		// New output while reading history: viewport stays anchored, unread grows.
		const anchored = transcript.scrollTop;
		transcriptText.setText(Array.from({ length: 40 }, (_, index) => `t${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		expect(transcript.scrollTop).toBe(anchored);
		rows = terminal.getViewport().map(plain);
		expect(rows.some((line) => /↓ \d+ new lines/.test(line))).toBe(true);

		// End returns to live output: canonical label, indicator gone.
		terminal.sendInput("\x1b[F");
		await terminal.waitForRender();
		expect(transcript.isFollowingEnd).toBe(true);
		rows = terminal.getViewport().map(plain);
		expect(rows.some((line) => line.includes("CANONICAL STATE · TOKEN-FREE"))).toBe(true);
		expect(rows.some((line) => line.includes("↓ "))).toBe(false);
		tui.stop();
	});

	it("keeps selection scoped to the pane where the drag starts", async () => {
		const terminal = new RecordingTerminal(60, 8);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(new Text("aaaa\naaaa\naaaa\naaaa", 0, 0), { primary: true });
		const workbench = new ScrollView(new Text("bbbb\nbbbb\nbbbb\nbbbb", 0, 0), { primary: false });
		tui.setLayoutRoot(
			new HStack([
				{ component: transcript, basis: 30, shrink: 0 },
				{ component: workbench, basis: 30, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		// Drag from the conversation into the workbench: the copy stays scoped.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<32;35;4M");
		terminal.sendInput("\x1b[<0;35;4m");
		await terminal.waitForRender();
		const copy = terminal.writes.find((write) => write.includes("\x1b]52;c;"));
		const decoded = copy ? Buffer.from(copy.split("\x1b]52;c;")[1]?.split("\x07")[0] ?? "", "base64").toString() : "";
		expect(decoded).toContain("aaaa");
		expect(decoded).not.toContain("bbbb");
		tui.stop();
	});
});

function assertVisible(terminal: VirtualTerminal, row: number, text: string): void {
	const lines = terminal.getViewport().map(plain);
	expect(lines[row] ?? "").toContain(text);
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

setTheme("aira-zhr");
