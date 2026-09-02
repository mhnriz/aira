import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewAiraVersion,
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestAiraRelease,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
	versionFromReleaseTag,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the pi.dev version check api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://pi.dev/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/pi",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/pi",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("extracts comparable versions from Aira release tags", () => {
		expect(versionFromReleaseTag("v0.1.0")).toBe("0.1.0");
		expect(versionFromReleaseTag("0.1.0")).toBe("0.1.0");
		expect(versionFromReleaseTag("aira-windows-0.84.3")).toBe("0.84.3");
		expect(versionFromReleaseTag("aira-windows-0.85.0-beta.1")).toBe("0.85.0-beta.1");
		expect(versionFromReleaseTag("v0.1.0")).not.toBe("0.1.1");
		// Unknown tag shapes fall back to the raw tag (string comparison).
		expect(versionFromReleaseTag("windows-installer")).toBe("windows-installer");
	});

	it("returns the latest Aira release: version, url, and a one-line note", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				tag_name: "v0.1.0",
				html_url: "https://github.com/mhnriz/aira/releases/tag/v0.1.0",
				body: "First stable Aira release.\n\nDetails in the release notes.",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestAiraRelease("0.1.0")).resolves.toEqual({
			version: "0.1.0",
			url: "https://github.com/mhnriz/aira/releases/tag/v0.1.0",
			note: "First stable Aira release. Details in the release notes.",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/mhnriz/aira/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/0\.1\.0 /),
					accept: "application/vnd.github+json",
				}),
			}),
		);
	});

	it("returns only Aira releases newer than the running version", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v0.1.0" }));
		vi.stubGlobal("fetch", fetchMock);

		// Same version as the running build: no notice.
		await expect(checkForNewAiraVersion("0.1.0")).resolves.toBeUndefined();
		fetchMock.mockResolvedValue(Response.json({ tag_name: "v0.2.0", html_url: "https://example.test/r" }));
		await expect(checkForNewAiraVersion("0.1.0")).resolves.toEqual({
			version: "0.2.0",
			url: "https://example.test/r",
		});
	});

	it("treats the current Aira build as up to date when the latest release is its own tag", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v0.1.0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewAiraVersion("0.1.0")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("skips the Aira release check when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewAiraVersion("0.1.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
