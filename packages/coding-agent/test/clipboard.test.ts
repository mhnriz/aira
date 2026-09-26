import { execFileSync, execSync, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import type * as OsModule from "os";
import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => {
	return {
		clipboard: {
			getText: vi.fn<() => Promise<string>>(),
			setText: vi.fn<(text: string) => Promise<void>>(),
		},
		execFileSync: vi.fn(),
		execSync: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

vi.mock("child_process", () => {
	return {
		execFileSync: mocks.execFileSync,
		execSync: mocks.execSync,
		spawn: mocks.spawn,
	};
});

vi.mock("os", async () => {
	return {
		...(await vi.importActual<typeof OsModule>("os")),
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.js", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let nativeResolved = false;

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	vi.stubEnv("WT_SESSION", "");
	vi.stubEnv("WSL_DISTRO_NAME", "");
	vi.stubEnv("WSLENV", "");
	stdoutWrites = [];
	nativeResolved = false;
	mocks.clipboard.getText.mockReset();
	mocks.clipboard.setText.mockReset();
	mocks.execFileSync.mockReset();
	mocks.execSync.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mocks.clipboard.getText.mockResolvedValue("");
	mocks.clipboard.setText.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		nativeResolved = true;
	});
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("readClipboardText", () => {
	test("returns native clipboard text", async () => {
		mocks.clipboard.getText.mockResolvedValue("clipboard text");

		await expect(readClipboardText()).resolves.toBe("clipboard text");
	});

	test("reads the Wayland clipboard before the stale native X11 clipboard", async () => {
		// Regression test for #7248.
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mockedExecFileSync.mockReturnValue("Wayland text");
		mocks.clipboard.getText.mockResolvedValue("stale X11 text");

		await expect(readClipboardText()).resolves.toBe("Wayland text");
		expect(mockedExecFileSync).toHaveBeenCalledWith("wl-paste", ["--no-newline", "--type", "text"], {
			encoding: "utf8",
			maxBuffer: 50 * 1024 * 1024,
			timeout: 5000,
		});
		expect(mocks.clipboard.getText).not.toHaveBeenCalled();
	});

	test("does not fall back to stale X11 text when the Wayland clipboard is empty", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mockedExecFileSync.mockReturnValue("");
		mocks.clipboard.getText.mockResolvedValue("stale X11 text");

		await expect(readClipboardText()).resolves.toBeNull();
		expect(mocks.clipboard.getText).not.toHaveBeenCalled();
	});

	test("falls back to the native clipboard when wl-paste is unavailable", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mockedExecFileSync.mockImplementation(() => {
			throw new Error("wl-paste unavailable");
		});
		mocks.clipboard.getText.mockResolvedValue("X11 fallback text");

		await expect(readClipboardText()).resolves.toBe("X11 fallback text");
	});

	test("returns null for empty or unavailable clipboard text", async () => {
		await expect(readClipboardText()).resolves.toBeNull();

		mocks.clipboard.getText.mockRejectedValue(new Error("clipboard unavailable"));
		await expect(readClipboardText()).resolves.toBeNull();
	});
});

describe("copyToClipboard", () => {
	test("local native success skips OSC 52 and shell fallbacks", async () => {
		await copyToClipboard("hello");

		expect(mocks.clipboard.setText).toHaveBeenCalledWith("hello");
		expect(osc52Writes()).toHaveLength(0);
		expect(mockedExecSync).not.toHaveBeenCalled();
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	test("remote native success emits OSC 52 after native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(osc52Writes()).toHaveLength(0);
			nativeResolved = true;
		});

		await copyToClipboard("hello");

		expect(nativeResolved).toBe(true);
		expect(osc52Writes()).toHaveLength(1);
		expect(mockedExecSync).not.toHaveBeenCalled();
	});

	test("local shell fallback success skips OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("local failure does not report an unverified OSC 52 write as success", async () => {
		// Regression test for #9618: a local copy must not be confirmed by unverified OSC 52 output.
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await expect(copyToClipboard("hello")).rejects.toThrow("Clipboard unavailable");
		expect(osc52Writes()).toHaveLength(0);
	});

	test("uses OSC 52 fallback when native and shell tools fail in a remote session", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow(
			"Clipboard unavailable: text exceeds the OSC 52 size limit",
		);
		expect(osc52Writes()).toHaveLength(0);
	});

	test("reports the X11 clipboard tools when no backend works", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("TERMUX_VERSION", "");
		vi.stubEnv("WAYLAND_DISPLAY", "");
		vi.stubEnv("DISPLAY", ":0");
		mockedExecSync.mockImplementation(() => {
			throw new Error("clipboard tool failed");
		});

		await expect(copyToClipboard("hello")).rejects.toThrow(
			"Clipboard unavailable: install `xclip` or `xsel`, or check X11 access",
		);
		expect(osc52Writes()).toHaveLength(0);
	});

	test("reports the Wayland clipboard tool before the X11 fallback", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("TERMUX_VERSION", "");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mockedExecSync.mockImplementation(() => {
			throw new Error("clipboard tool failed");
		});

		await expect(copyToClipboard("hello")).rejects.toThrow(
			"Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access",
		);
	});

	test("display-less Linux falls back to OSC 52", async () => {
		// Regression test for #9688: containers without X11/Wayland access.
		mockedPlatform.mockReturnValue("linux");
		await copyToClipboard("hello");
		expect(mocks.execSync).not.toHaveBeenCalled();
		expect(osc52Writes()).toHaveLength(1);
	});

	test("WSL without a display writes the Windows clipboard through PowerShell", async () => {
		// Regression test for #9688: WSL with WSLg disabled.
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		let written: string | undefined;
		mocks.execFileSync.mockImplementation((name: string, args: string[]) => {
			if (name !== "wslpath") return Buffer.alloc(0);
			written = readFileSync(args[1]!, "utf8");
			return "\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt\n";
		});
		await copyToClipboard("héllo");
		expect(mocks.execFileSync.mock.calls.map(([name]) => name)).toEqual(["wslpath", "powershell.exe"]);
		expect(written).toBe("héllo");
		const [, wslpathArgs] = mocks.execFileSync.mock.calls[0]!;
		expect(existsSync(wslpathArgs[1]!)).toBe(false);
		const [, powershellArgs] = mocks.execFileSync.mock.calls[1]!;
		expect(powershellArgs[2]).toContain("Set-Clipboard");
		expect(powershellArgs[2]).toContain("'\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt'");
		expect(osc52Writes()).toHaveLength(0);
	});

	test("WSL falls back to OSC 52 when Windows interop is unavailable", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		mocks.execFileSync.mockImplementation(() => {
			throw new Error("interop unavailable");
		});
		await copyToClipboard("hello");
		expect(mocks.execFileSync.mock.calls.map(([name]) => name)).toEqual(["wslpath"]);
		expect(osc52Writes()).toHaveLength(1);
	});

	test("WSL in Windows Terminal prefers OSC 52 over PowerShell", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		await copyToClipboard("hello");
		expect(mocks.execFileSync).not.toHaveBeenCalled();
		expect(osc52Writes()).toHaveLength(1);
	});

	test("WSL in Windows Terminal emits OSC 52 once in a remote session", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		vi.stubEnv("SSH_CONNECTION", "client server");
		await copyToClipboard("hello");
		expect(mocks.execFileSync).not.toHaveBeenCalled();
		expect(osc52Writes()).toHaveLength(1);
	});

	test("WSL in Windows Terminal uses PowerShell for oversized OSC 52 payloads", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		mocks.execFileSync.mockImplementation((name: string) => (name === "wslpath" ? "C:\\clip.txt" : Buffer.alloc(0)));
		await copyToClipboard("x".repeat(80_000));
		expect(mocks.execFileSync.mock.calls.map(([name]) => name)).toEqual(["wslpath", "powershell.exe"]);
		expect(osc52Writes()).toHaveLength(0);
	});

	test("WSL with a display prefers the Linux clipboard tools", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.isWaylandSession.mockReturnValue(true);
		mocks.spawn.mockReturnValue({
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				if (event === "close") queueMicrotask(() => handler(0));
			}),
			stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
		} as unknown as ReturnType<typeof spawn>);
		await copyToClipboard("hello");
		expect(mocks.spawn).toHaveBeenCalledWith("wl-copy", [], expect.anything());
		expect(mocks.execFileSync).not.toHaveBeenCalled();
		expect(osc52Writes()).toHaveLength(0);
	});
});
