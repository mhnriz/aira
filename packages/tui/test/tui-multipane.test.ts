import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Conversation + Workbench style split: an HStack of two independent ScrollViews. */
function splitPane(rows = 8, conversationLines = 12, workbenchLines = 12) {
	const terminal = new VirtualTerminal(30, rows);
	const tui = new TuiAltScreen(terminal);
	const conversationText = new Text(
		Array.from({ length: conversationLines }, (_, index) => `c${index + 1}`).join("\n"),
		0,
		0,
	);
	const workbenchText = new Text(
		Array.from({ length: workbenchLines }, (_, index) => `w${index + 1}`).join("\n"),
		0,
		0,
	);
	const conversation = new ScrollView(conversationText, { follow: "end", primary: true });
	const workbench = new ScrollView(workbenchText, { follow: "end", primary: false });
	tui.setLayoutRoot(
		new HStack([
			{ component: conversation, basis: 15, shrink: 0 },
			{ component: workbench, basis: 15, shrink: 0 },
		]),
	);
	return { terminal, tui, conversationText, workbenchText, conversation, workbench };
}

describe("TuiAltScreen multi-pane viewports", () => {
	it("keeps conversation and workbench scroll offsets independent", async () => {
		const { terminal, tui, conversation, workbench } = splitPane(6, 10, 10);
		tui.start();
		await terminal.waitForRender();

		// Both panes follow their own end (maxScrollTop = 10 - 6 = 4).
		assert.strictEqual(conversation.scrollTop, 4);
		assert.strictEqual(workbench.scrollTop, 4);

		// Wheel over the conversation (x=5) scrolls only the conversation.
		terminal.sendInput("\x1b[<64;5;1M");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 3);
		assert.strictEqual(workbench.scrollTop, 4);

		// Wheel over the workbench (x=25) scrolls only the workbench.
		terminal.sendInput("\x1b[<64;25;1M");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 3);
		assert.strictEqual(workbench.scrollTop, 3);

		// Wheel over the conversation again scrolls it further without moving workbench.
		terminal.sendInput("\x1b[<64;5;1M");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 2);
		assert.strictEqual(workbench.scrollTop, 3);
		tui.stop();
	});

	it("routes keyboard navigation to the configured scroll target", async () => {
		const { terminal, tui, conversation, workbench } = splitPane(6, 10, 10);
		tui.start();
		await terminal.waitForRender();

		// Default: keyboard navigation targets the primary (conversation).
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 2);
		assert.strictEqual(workbench.scrollTop, 4);

		// Point keyboard navigation at the workbench pane.
		tui.setKeyboardScrollTarget(workbench);
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 2);
		assert.strictEqual(workbench.scrollTop, 2);

		// Home/End now target the workbench too.
		terminal.sendInput("\x1b[H");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 2);
		assert.strictEqual(workbench.scrollTop, 0);

		terminal.sendInput("\x1b[F");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 2);
		assert.strictEqual(workbench.scrollTop, 4);

		// Clearing the target restores primary navigation.
		tui.setKeyboardScrollTarget(undefined);
		terminal.sendInput("\x1b[H");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 0);
		assert.strictEqual(workbench.scrollTop, 4);
		tui.stop();
	});

	it("reports unread lines below the viewport and clears them at the end", async () => {
		const { terminal, tui, conversationText, conversation } = splitPane(4, 10, 10);
		tui.start();
		await terminal.waitForRender();

		// Following at the end (maxScrollTop = 10 - 4 = 6): no unread output.
		assert.strictEqual(conversation.getUnreadLines(), 0);

		// Page up: content below the viewport becomes "new output".
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 5);
		assert.strictEqual(conversation.getUnreadLines(), 1);

		// New content arrives while scrolled: unread count grows, viewport stays anchored.
		conversationText.setText(Array.from({ length: 14 }, (_, index) => `c${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 5);
		assert.strictEqual(conversation.getUnreadLines(), 14 - 4 - 5);

		// End returns to live output and clears the unread indicator.
		terminal.sendInput("\x1b[F");
		await terminal.waitForRender();
		assert.strictEqual(conversation.getUnreadLines(), 0);
		assert.strictEqual(conversation.isFollowingEnd, true);
		tui.stop();
	});

	it("clamps both pane offsets on resize", async () => {
		const { terminal, tui, conversation, workbench } = splitPane(6, 20, 20);
		tui.start();
		await terminal.waitForRender();

		// Both follow their own end (maxScrollTop = 20 - 6 = 14).
		assert.strictEqual(conversation.scrollTop, 14);
		assert.strictEqual(workbench.scrollTop, 14);

		// Page up both panes (page scroll = 6 - 4 = 2) -> 12.
		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;25;2M");
		await terminal.waitForRender();
		assert.strictEqual(conversation.scrollTop, 12);
		assert.strictEqual(workbench.scrollTop, 13);

		// Shrink the viewport so maxScrollTop (20 - 12 = 8) < current offset: clamp.
		terminal.resize(30, 12);
		await terminal.waitForRender();
		assert.ok(conversation.scrollTop >= 0 && conversation.scrollTop <= 8);
		assert.ok(workbench.scrollTop >= 0 && workbench.scrollTop <= 8);

		// Growing back keeps offsets valid and does not re-follow (still scrolled).
		terminal.resize(30, 6);
		await terminal.waitForRender();
		assert.ok(conversation.scrollTop >= 0 && conversation.scrollTop <= 14);
		assert.ok(workbench.scrollTop >= 0 && workbench.scrollTop <= 14);
		tui.stop();
	});

	it("keeps a fixed footer while both panes scroll", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TuiAltScreen(terminal);
		const conversationText = new Text(Array.from({ length: 14 }, (_, index) => `c${index + 1}`).join("\n"), 0, 0);
		const workbenchText = new Text(Array.from({ length: 14 }, (_, index) => `w${index + 1}`).join("\n"), 0, 0);
		const conversation = new ScrollView(conversationText, { follow: "end", primary: true });
		const workbench = new ScrollView(workbenchText, { follow: "end", primary: false });
		const split = new HStack([
			{ component: conversation, basis: 14, shrink: 0 },
			{ component: workbench, basis: 14, shrink: 0 },
		]);
		tui.setLayoutRoot(
			new VStack([
				{ component: split, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("footer", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		// Scroll both panes; the footer row never moves.
		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;25;2M");
		await terminal.waitForRender();
		const viewport = terminal.getViewport().map((line) => line.trimEnd());
		assert.strictEqual(viewport[viewport.length - 1], "footer");
		tui.stop();
	});
});
