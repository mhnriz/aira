import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const clipboardMocks = vi.hoisted(() => ({
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

const imageMocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<unknown | null>>(),
	extensionForImageMimeType: vi.fn<(mimeType: string) => string | null>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);
vi.mock("../src/utils/clipboard-image.ts", () => imageMocks);

type PasteContext = {
	editor: { handleInput?: (data: string) => void; insertTextAtCursor?: (text: string) => void };
	ui: { requestRender: () => void };
};

type PastePrototype = {
	handleClipboardPaste(this: PasteContext): Promise<void>;
};

const pastePrototype = InteractiveMode.prototype as unknown as PastePrototype;

/**
 * Ctrl+V clipboard paste routing: text is fed through the bracketed-paste
 * path so large clipboard content collapses to a paste marker (and the
 * second Ctrl+V can expand it), while images still insert their file path.
 */
describe("InteractiveMode clipboard paste routing", () => {
	beforeEach(() => {
		clipboardMocks.readClipboardText.mockReset();
		imageMocks.readClipboardImage.mockReset();
		imageMocks.extensionForImageMimeType.mockReset();
	});
	it("routes clipboard text through the bracketed-paste collapse path", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text\nwith lines");
		const handleInput = vi.fn<(data: string) => void>();
		const requestRender = vi.fn();
		const context: PasteContext = {
			editor: { handleInput },
			ui: { requestRender },
		};

		await pastePrototype.handleClipboardPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\nwith lines\x1b[201~");
		expect(requestRender).toHaveBeenCalled();
	});

	it("keeps the image path insertion path unchanged", async () => {
		imageMocks.readClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
		imageMocks.extensionForImageMimeType.mockReturnValue("png");
		const handleInput = vi.fn<(data: string) => void>();
		const insertTextAtCursor = vi.fn<(text: string) => void>();
		const requestRender = vi.fn();
		const context: PasteContext = {
			editor: { handleInput, insertTextAtCursor },
			ui: { requestRender },
		};

		await pastePrototype.handleClipboardPaste.call(context);

		expect(handleInput).not.toHaveBeenCalled();
		expect(insertTextAtCursor).toHaveBeenCalledOnce();
		const path = insertTextAtCursor.mock.calls[0]![0] as string;
		expect(path).toMatch(/[/\\]pi-clipboard-.*\.png$/);
		expect(imageMocks.readClipboardImage).toHaveBeenCalledOnce();
	});

	it("does nothing when the clipboard is empty or unreadable", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue(null);
		const handleInput = vi.fn<(data: string) => void>();
		const requestRender = vi.fn();
		const context: PasteContext = {
			editor: { handleInput },
			ui: { requestRender },
		};

		await pastePrototype.handleClipboardPaste.call(context);

		expect(handleInput).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});
});
