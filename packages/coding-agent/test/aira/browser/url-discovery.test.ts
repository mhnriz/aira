/**
 * Phase 7 — local URL discovery tests.
 *
 * Deterministic parsing of dev-server output; no network probing. Loopback
 * only; conventions only when output evidence is absent.
 */
import { describe, expect, it } from "vitest";
import {
	conventionalDevPorts,
	discoverLocalUrl,
	isSafeLocalUrl,
	localUrlsFromDevOutput,
} from "../../../src/aira/browser/url-discovery.ts";
import type { AiraProjectProfile } from "../../../src/aira/project/profile.ts";

const viteProfile: AiraProjectProfile = {
	root: "/tmp/proj",
	git: { hasGit: true, root: "/tmp/proj" },
	languages: ["typescript"],
	frameworks: ["vite", "react"],
	packageManagers: ["npm"],
	testCommands: [],
	buildCommands: [],
	checkCommands: [],
	devCommands: [],
	browserRelevant: true,
	deploymentHints: [],
	confidence: "high",
};

const backendProfile: AiraProjectProfile = {
	root: "/tmp/be",
	git: { hasGit: true, root: "/tmp/be" },
	languages: ["python"],
	frameworks: [],
	packageManagers: [],
	testCommands: [],
	buildCommands: [],
	checkCommands: [],
	devCommands: [],
	browserRelevant: false,
	deploymentHints: [],
	confidence: "high",
};

describe("Phase 7 — local URL discovery", () => {
	it("parses vite-style dev-server output", () => {
		const output = [
			"  VITE v6.0.0  ready in 420 ms",
			"",
			"  ➜  Local:   http://localhost:5173/",
			"  ➜  Network: use --host to expose",
		].join("\n");
		expect(localUrlsFromDevOutput(output)).toEqual(["http://localhost:5173"]);
	});

	it("parses node-style listening lines", () => {
		const output = "Server listening on http://127.0.0.1:4321\nready";
		expect(localUrlsFromDevOutput(output)).toEqual(["http://127.0.0.1:4321"]);
	});

	it("never extracts public hosts", () => {
		const output = "App running at https://example.com and http://localhost:3000";
		expect(localUrlsFromDevOutput(output)).toEqual(["http://localhost:3000"]);
	});

	it("deduplicates repeated URL lines and bounds the result", () => {
		const output = Array.from({ length: 5 }, () => "Local: http://localhost:3000").join("\n");
		expect(localUrlsFromDevOutput(output)).toEqual(["http://localhost:3000"]);
	});

	it("prefers output evidence over framework conventions", () => {
		const evidence = discoverLocalUrl("Local: http://localhost:9999\n", viteProfile);
		expect(evidence).toEqual({ url: "http://localhost:9999", confidence: "output", detail: "dev process output" });
	});

	it("falls back to framework conventions only without output evidence", () => {
		const evidence = discoverLocalUrl("", viteProfile);
		expect(evidence.confidence).toBe("convention");
		expect(evidence.url).toBe("http://localhost:5173");
	});

	it("reports needs-url truthfully when nothing is known", () => {
		const evidence = discoverLocalUrl("", backendProfile);
		expect(evidence.confidence).toBe("none");
		expect(evidence.url).toBeUndefined();
	});

	it("lists conventional dev ports per framework deterministically", () => {
		expect(conventionalDevPorts(viteProfile)).toEqual([5173, 3000]);
		expect(conventionalDevPorts(backendProfile)).toEqual([]);
		expect(conventionalDevPorts(undefined)).toEqual([]);
	});

	it("accepts only safe loopback targets", () => {
		expect(isSafeLocalUrl("http://localhost:3000")).toBe(true);
		expect(isSafeLocalUrl("http://127.0.0.1:5173")).toBe(true);
		expect(isSafeLocalUrl("https://example.com")).toBe(false);
		expect(isSafeLocalUrl("file:///tmp/x")).toBe(false);
		expect(isSafeLocalUrl("not a url")).toBe(false);
	});
});
