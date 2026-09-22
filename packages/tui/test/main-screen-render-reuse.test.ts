import assert from "node:assert";
import { describe, it } from "node:test";
import { deleteKittyImage, encodeKitty } from "../src/terminal-image.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class RecordingTerminal {
	writes: string[] = [];
	private cols: number;
	private rws: number;
	constructor(columns: number, rows: number) {
		this.cols = columns;
		this.rws = rows;
	}
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	get columns(): number {
		return this.cols;
	}
	get rows(): number {
		return this.rws;
	}
	get kittyProtocolActive(): boolean {
		return true;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	resize(columns: number, rows: number): void {
		this.cols = columns;
		this.rws = rows;
	}
	clearWrites(): void {
		this.writes = [];
	}
	text(): string {
		return this.writes.join("");
	}
}

interface KittyScanCounts {
	expand: number;
	expandLines: number;
	collect: number;
	collectLines: number;
	probe: number;
	probeLines: number;
}

/** Counts full-transcript Kitty scans by shadowing the private methods on the instance. */
function instrumentKittyScans(tui: TuiMainScreen): KittyScanCounts {
	const counts: KittyScanCounts = { expand: 0, expandLines: 0, collect: 0, collectLines: 0, probe: 0, probeLines: 0 };
	const target = tui as unknown as {
		expandChangedRangeForKittyImages: (
			first: number,
			last: number,
			lines: string[],
		) => { firstChanged: number; lastChanged: number };
		collectKittyImageIds: (lines: string[]) => Set<number>;
		hasKittyImageIdsInRange: (lines: string[], first: number, last: number) => boolean;
	};
	const originalExpand = target.expandChangedRangeForKittyImages;
	target.expandChangedRangeForKittyImages = function (first, last, lines) {
		counts.expand++;
		counts.expandLines += lines.length;
		return originalExpand.call(this, first, last, lines);
	};
	const originalCollect = target.collectKittyImageIds;
	target.collectKittyImageIds = function (lines) {
		counts.collect++;
		counts.collectLines += lines.length;
		return originalCollect.call(this, lines);
	};
	const originalProbe = target.hasKittyImageIdsInRange;
	target.hasKittyImageIdsInRange = function (lines, first, last) {
		counts.probe++;
		counts.probeLines += Math.max(0, Math.min(last, lines.length - 1) - Math.max(0, first) + 1);
		return originalProbe.call(this, lines, first, last);
	};
	return counts;
}

/** Exposes the legacy full-transcript normalization for equivalence checks. */
class LegacyNormalizingTui extends TuiMainScreen {
	normalizeAll(lines: string[]): string[] {
		return this.applyLineResets(lines.slice());
	}
	protected override applyLineResetsReusing(lines: string[]): string[] {
		return this.applyLineResets(lines);
	}
}

class CapturingTui extends TuiMainScreen {
	captured: { raw: string[]; out: string[] }[] = [];
	protected override applyLineResetsReusing(
		lines: string[],
		previousRaw: string[],
		previousNormalized: string[],
	): string[] {
		const out = super.applyLineResetsReusing(lines, previousRaw, previousNormalized);
		this.captured.push({ raw: lines, out });
		return out;
	}
}

describe("main screen Kitty image fast path", () => {
	it("does not scan the whole transcript for a text-only streaming tail update", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 2000 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.renderNow();

		const counts = instrumentKittyScans(tui);
		component.lines = [...component.lines.slice(0, -1), "Line 1999 changed"];
		tui.renderNow();

		assert.equal(counts.expand, 0, "no full Kitty range expansion for a text-only tail update");
		assert.equal(counts.collect, 0, "no full Kitty id collection for a text-only tail update");
		assert.equal(counts.expandLines, 0, "Kitty expansion must inspect no transcript lines");
		assert.equal(counts.collectLines, 0, "Kitty collection must inspect no transcript lines");
		assert.equal(counts.probeLines, 1, "only the changed line is inspected to prove no image exists");
		assert.ok(terminal.text().includes("Line 1999 changed"), "the changed tail line is still rendered");
		tui.stop();
	});

	it("produces byte-identical output to the forced slow Kitty path", () => {
		const imageA = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 91, moveCursor: false });
		const imageB = encodeKitty("BBBB", { columns: 2, rows: 2, imageId: 92, moveCursor: false });
		const scripts: string[][] = [
			["A", "B"],
			[imageA, "B"],
			[imageA, "B", "C"],
			["A", "B", "C"],
			[imageA, imageB],
			[imageA, imageB, "tail"],
			[imageB, "tail"],
			["no images", "tail"],
		];
		const run = (tui: TuiMainScreen, terminal: RecordingTerminal): string => {
			const component = new TestComponent();
			tui.addChild(component);
			for (const lines of scripts) {
				component.lines = [...lines];
				tui.renderNow();
			}
			tui.stop();
			return terminal.text();
		};
		const fastTerminal = new RecordingTerminal(40, 10);
		const slowTerminal = new RecordingTerminal(40, 10);
		const fast = run(new TuiMainScreen(fastTerminal), fastTerminal);
		const slowTui = new TuiMainScreen(slowTerminal);
		(slowTui as unknown as { hasKittyImageIdsInRange: () => boolean }).hasKittyImageIdsInRange = () => true;
		const slow = run(slowTui, slowTerminal);
		assert.equal(fast, slow, "the Kitty fast path must not change emitted output");
	});

	it("detects the first Kitty image introduced into a long text-only transcript", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 500 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.renderNow();

		const counts = instrumentKittyScans(tui);
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 11, moveCursor: false });
		component.lines = [...component.lines.slice(0, -1), image];
		terminal.clearWrites();
		tui.renderNow();

		assert.ok(counts.expand > 0, "introducing an image must run the Kitty range check");
		assert.ok(counts.collect > 0, "introducing an image must collect the new image id");
		assert.ok(terminal.text().includes(image), "the new image line is emitted");
		tui.stop();
	});

	it("keeps tracking an unchanged image outside the changed text range", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 21, moveCursor: false });
		component.lines = [image, ...Array.from({ length: 300 }, (_, i) => `Line ${i}`)];
		tui.addChild(component);
		tui.renderNow();

		// Change a line far below the image.
		component.lines = [...component.lines];
		component.lines[component.lines.length - 1] = "tail changed";
		terminal.clearWrites();
		tui.renderNow();
		assert.ok(!terminal.text().includes(deleteKittyImage(21)), "untouched image must not be deleted");

		// Remove the image line entirely; the id must still be tracked and deleted.
		component.lines = [...component.lines.slice(1), "tail changed"];
		terminal.clearWrites();
		tui.renderNow();
		assert.ok(terminal.text().includes(deleteKittyImage(21)), "removed image must be deleted");
		tui.stop();
	});

	it("deletes and redraws when a tracked image's content changes", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		component.lines = ["top", oldImage];
		tui.addChild(component);
		tui.renderNow();

		const newImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		component.lines = [newImage, ""];
		terminal.clearWrites();
		tui.renderNow();

		const text = terminal.text();
		const deleteIndex = text.indexOf(deleteKittyImage(42));
		const drawIndex = text.indexOf(newImage);
		assert.ok(deleteIndex >= 0, "changed image must be deleted");
		assert.ok(drawIndex >= 0, "changed image must be redrawn");
		assert.ok(deleteIndex < drawIndex, "deletion must precede redraw");
		tui.stop();
	});

	it("keeps multiple images tracked independently", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const imageA = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 31, moveCursor: false });
		const imageB = encodeKitty("BBBB", { columns: 2, rows: 2, imageId: 32, moveCursor: false });
		component.lines = [imageA, "", "middle", imageB, ""];
		tui.addChild(component);
		tui.renderNow();

		// Replace image B only.
		const imageB2 = encodeKitty("CCCC", { columns: 2, rows: 2, imageId: 33, moveCursor: false });
		component.lines = [imageA, "", "middle", imageB2, ""];
		terminal.clearWrites();
		tui.renderNow();

		const text = terminal.text();
		assert.ok(!text.includes(deleteKittyImage(31)), "unchanged image A must not be deleted");
		assert.ok(text.includes(deleteKittyImage(32)), "replaced image B must be deleted");
		assert.ok(text.includes(imageB2), "replacement image must be drawn");
		tui.stop();
	});

	it("handles resize with an image present", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 55, moveCursor: false });
		component.lines = ["before", image, "after"];
		tui.addChild(component);
		tui.renderNow();

		terminal.clearWrites();
		terminal.resize(60, 24);
		tui.renderNow();

		const text = terminal.text();
		assert.ok(text.includes(deleteKittyImage(55)), "resize full render must delete the previous image id");
		assert.ok(text.includes(image), "resize full render must redraw the image");
		tui.stop();
	});

	it("keeps an image tracked while the transcript scrolls", () => {
		const terminal = new RecordingTerminal(40, 6);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 61, moveCursor: false });
		component.lines = ["a", "b", image, "", "c", "d"];
		tui.addChild(component);
		tui.renderNow();

		// Append to force scrolling; the image line is unchanged.
		component.lines = [...component.lines, "new1", "new2"];
		terminal.clearWrites();
		tui.renderNow();
		assert.ok(!terminal.text().includes(deleteKittyImage(61)), "scrolling must not delete an unchanged image");
		assert.ok(terminal.text().includes("new2"), "new scrollback lines are emitted");
		tui.stop();
	});
});

describe("Slice A output-equivalence gate", () => {
	it("is byte-identical to fully legacy behavior across the streaming, markdown, tool, image, overlay, resize and scrollback matrix", () => {
		const imageA = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 101, moveCursor: false });
		const imageA2 = encodeKitty("CCCC", { columns: 2, rows: 2, imageId: 101, moveCursor: false });
		const imageB = encodeKitty("BBBB", { columns: 2, rows: 2, imageId: 102, moveCursor: false });

		const frames: string[][] = [
			[],
			["plain streaming line 0"],
			["plain streaming line 0", "plain streaming line 1"],
			["plain streaming line 0", "plain streaming line 1", "tail chunk"],
			["plain streaming line 0", "plain streaming line 1", "tail chunk more text"],
			["# Heading", "paragraph with **bold** and `code`", "- item", "- item 2"],
			["```ts", "const x: number = 1;", "```"],
			["\x1b[31mred\x1b[0m plain \x1b[1mbold\x1b[0m"],
			["tab\tsep", "", "blank above"],
			["→ bash(ls -la)", "⎿  output recorded"],
			["✓ tool result: 42 files"],
			["insert before", "→ bash(ls -la)", "⎿  output recorded"],
			["→ bash(ls -la)", "⎿  output recorded"],
			["→ bash(ls -la)", "⎿  output recorded", "trailing"],
			[imageA],
			[imageA, "after image"],
			[imageA2, "after image"],
			[imageB, "after image"],
			[imageA, imageB, "two images"],
			[imageA, "two images"],
			["no images now"],
			Array.from({ length: 40 }, (_, i) => `scrollback ${i}`),
			Array.from({ length: 40 }, (_, i) => `scrollback ${i}`),
			Array.from({ length: 42 }, (_, i) => `scrollback ${i}`),
			Array.from({ length: 38 }, (_, i) => `scrollback ${i}`),
		];

		const run = (makeTui: (terminal: RecordingTerminal) => TuiMainScreen, terminal: RecordingTerminal): string => {
			const tui = makeTui(terminal);
			const component = new TestComponent();
			tui.addChild(component);
			const overlay = new TestComponent();
			overlay.lines = ["overlay row"];
			tui.showOverlay(overlay, { width: 12, maxHeight: 1, anchor: "top-right" });
			for (const lines of frames) {
				component.lines = [...lines];
				tui.renderNow();
			}
			// resize/reflow
			terminal.resize(50, 20);
			tui.renderNow();
			// no-change frames
			tui.renderNow();
			tui.renderNow(true);
			tui.renderNow();
			tui.stop();
			return terminal.text();
		};

		const optimizedTerminal = new RecordingTerminal(80, 24);
		const legacyTerminal = new RecordingTerminal(80, 24);
		const optimized = run((terminal) => new TuiMainScreen(terminal), optimizedTerminal);
		const legacy = run((terminal) => {
			const tui = new LegacyNormalizingTui(terminal);
			(tui as unknown as { hasKittyImageIdsInRange: () => boolean }).hasKittyImageIdsInRange = () => true;
			return tui;
		}, legacyTerminal);

		assert.ok(optimized.length > 0, "the script must emit output");
		assert.equal(optimized, legacy, "optimized Slice A output must be byte-identical to fully legacy output");
	});
});

describe("main screen line reset reuse", () => {
	it("reuses normalized strings for unchanged lines and renormalizes changed lines", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new CapturingTui(terminal);
		const component = new TestComponent();
		component.lines = ["alpha", "beta", "gamma"];
		tui.addChild(component);
		tui.renderNow();

		component.lines = ["alpha", "beta", "gamma changed"];
		tui.renderNow();

		assert.equal(tui.captured.length, 2);
		const first = tui.captured[0];
		const second = tui.captured[1];
		assert.equal(second.out[0], first.out[0], "unchanged line 0 must reuse the previous normalized string");
		assert.equal(second.out[1], first.out[1], "unchanged line 1 must reuse the previous normalized string");
		assert.notEqual(second.out[2], first.out[2], "changed line 2 must be renormalized");

		const legacy = new LegacyNormalizingTui(new RecordingTerminal(80, 24));
		assert.equal(second.out[2], legacy.normalizeAll(["gamma changed"])[0], "changed line normalization is unchanged");
		assert.equal(second.out[0], legacy.normalizeAll(["alpha"])[0], "reused line equals the legacy normalization");
		tui.stop();
	});

	it("leaves image lines untouched", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new CapturingTui(terminal);
		const component = new TestComponent();
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 71, moveCursor: false });
		component.lines = ["text", image, ""];
		tui.addChild(component);
		tui.renderNow();

		const captured = tui.captured[0];
		assert.equal(captured.out[1], captured.raw[1], "image line must be emitted verbatim");
		assert.equal(captured.out[1], image, "image line must not receive a segment reset");
		tui.stop();
	});

	it("reuses unchanged lines outside the changed region without stale association", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new CapturingTui(terminal);
		const component = new TestComponent();
		component.lines = ["A", "B", "C", "D"];
		tui.addChild(component);
		tui.renderNow();

		component.lines = ["A", "X", "C", "D"];
		tui.renderNow();

		const first = tui.captured[0];
		const second = tui.captured[1];
		assert.equal(second.out[0], first.out[0], "prefix before the change is reused");
		assert.equal(second.out[2], first.out[2], "suffix after the change is reused");
		assert.equal(second.out[3], first.out[3], "suffix after the change is reused");
		assert.notEqual(second.out[1], first.out[1], "changed middle line is renormalized");

		const legacy = new LegacyNormalizingTui(new RecordingTerminal(80, 24));
		assert.equal(second.out[1], legacy.normalizeAll(["X"])[0], "renormalized line matches legacy output");
		tui.stop();
	});

	it("reuses every unchanged line of a long transcript", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new CapturingTui(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 1000 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.renderNow();

		component.lines = [...component.lines.slice(0, -1), "Line 999 changed"];
		tui.renderNow();

		const first = tui.captured[0];
		const second = tui.captured[1];
		for (let i = 0; i < first.out.length - 1; i++) {
			assert.equal(second.out[i], first.out[i], `line ${i} must be reused`);
		}
		assert.notEqual(second.out[second.out.length - 1], first.out[first.out.length - 1]);
		tui.stop();
	});

	it("emits nothing when a frame is unchanged", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = ["A", "B", "C"];
		tui.addChild(component);
		tui.renderNow();

		terminal.clearWrites();
		tui.renderNow();
		assert.equal(terminal.text(), "", "a no-change frame must not write to the terminal");
		tui.stop();
	});

	it("produces byte-identical terminal output to the legacy path across insertion, deletion, ANSI, images, overlays and resize", () => {
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 81, moveCursor: false });
		const image2 = encodeKitty("BBBB", { columns: 2, rows: 2, imageId: 82, moveCursor: false });
		const scripts: string[][] = [
			[],
			["A"],
			["A", "B", "C"],
			["A", "B", "C changed"],
			["A", "X", "B", "C changed"],
			["A", "B", "C changed"],
			["A", "B"],
			["A", "\x1b[31mred\x1b[0m", "B"],
			["A", "", "B", "\ttabbed"],
			[image, "A", "B"],
			["A", "B", image2],
			["A", "B", "C"],
			Array.from({ length: 40 }, (_, i) => `long ${i}`),
		];

		const runScript = (tui: TuiMainScreen, terminal: RecordingTerminal): string => {
			const component = new TestComponent();
			tui.addChild(component);
			const overlayComponent = new TestComponent();
			overlayComponent.lines = ["overlay"];
			tui.showOverlay(overlayComponent, { width: 10, maxHeight: 1, anchor: "top-right" });
			for (const lines of scripts) {
				component.lines = [...lines];
				tui.renderNow();
			}
			terminal.resize(50, 24);
			tui.renderNow();
			component.lines = [...scripts[scripts.length - 1]];
			tui.renderNow();
			tui.stop();
			return terminal.text();
		};

		const incrementalTerminal = new RecordingTerminal(80, 24);
		const legacyTerminal = new RecordingTerminal(80, 24);
		const incremental = runScript(new TuiMainScreen(incrementalTerminal), incrementalTerminal);
		const legacy = runScript(new LegacyNormalizingTui(legacyTerminal), legacyTerminal);
		assert.equal(incremental, legacy, "incremental normalization must match legacy terminal output exactly");
	});

	it("matches the legacy path when a normalizing TUI is reused after a full state reset", () => {
		const run = (tui: TuiMainScreen, terminal: RecordingTerminal): string => {
			const component = new TestComponent();
			tui.addChild(component);
			component.lines = ["one", "two", "three"];
			tui.renderNow();
			tui.renderNow(true);
			component.lines = ["one", "two", "three changed"];
			tui.renderNow();
			tui.stop();
			return terminal.text();
		};
		const incrementalTerminal = new RecordingTerminal(80, 24);
		const legacyTerminal = new RecordingTerminal(80, 24);
		assert.equal(
			run(new TuiMainScreen(incrementalTerminal), incrementalTerminal),
			run(new LegacyNormalizingTui(legacyTerminal), legacyTerminal),
		);
	});
});
