/**
 * Phase 7 — ambient eligibility tests.
 *
 * Availability ≠ eligibility ≠ activation ≠ context injection. Eligibility is
 * evidence-based; merely containing frontend code triggers nothing.
 */
import { describe, expect, it } from "vitest";
import { decideBrowserEligibility, isBrowserRelevantPath } from "../../../src/aira/browser/eligibility.ts";
import type { AiraProjectProfile } from "../../../src/aira/project/profile.ts";

const browserProject: AiraProjectProfile = {
	root: "/tmp/web",
	git: { hasGit: true, root: "/tmp/web" },
	languages: ["typescript"],
	frameworks: ["react"],
	packageManagers: ["npm"],
	testCommands: [],
	buildCommands: [],
	checkCommands: [],
	devCommands: [],
	browserRelevant: true,
	deploymentHints: [],
	confidence: "high",
};

const backendProject: AiraProjectProfile = {
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

describe("Phase 7 — ambient eligibility", () => {
	it("no project → not eligible", () => {
		const result = decideBrowserEligibility({
			project: undefined,
			mode: "build",
			devRunning: true,
			localUrl: "http://localhost:5173",
		});
		expect(result.eligible).toBe(false);
		expect(result.changeRelevant).toBe(false);
	});

	it("browserRelevant=false + README edit + dev running → still not eligible", () => {
		const result = decideBrowserEligibility({
			project: backendProject,
			mode: "build",
			devRunning: true,
			localUrl: "http://localhost:8000",
			lastEditPath: "README.md",
		});
		expect(result.eligible).toBe(false);
	});

	it("backend-only edit in a browser-relevant project → not eligible (no signal)", () => {
		const result = decideBrowserEligibility({
			project: browserProject,
			mode: "build",
			devRunning: false,
			lastEditPath: "src/utils/calc.ts",
		});
		expect(result.eligible).toBe(false);
		expect(result.changeRelevant).toBe(false);
	});

	it("frontend edit + dev running + URL → eligible, change relevant", () => {
		const result = decideBrowserEligibility({
			project: browserProject,
			mode: "build",
			devRunning: true,
			localUrl: "http://localhost:5173",
			lastEditPath: "src/components/Player.tsx",
		});
		expect(result.eligible).toBe(true);
		expect(result.changeRelevant).toBe(true);
	});

	it("frontend edit without dev server → eligible via change but no URL", () => {
		const result = decideBrowserEligibility({
			project: browserProject,
			mode: "build",
			devRunning: false,
			lastEditPath: "src/App.tsx",
		});
		expect(result.eligible).toBe(true);
		expect(result.changeRelevant).toBe(true);
	});

	it("explicit browser request wins even without profile relevance", () => {
		const result = decideBrowserEligibility({
			project: backendProject,
			mode: "build",
			devRunning: false,
			explicitRequest: true,
		});
		expect(result.eligible).toBe(true);
	});

	it("PLAN never arms ambient eligibility (observation still possible when open)", () => {
		const result = decideBrowserEligibility({
			project: browserProject,
			mode: "plan",
			devRunning: true,
			localUrl: "http://localhost:5173",
			lastEditPath: "src/App.tsx",
		});
		expect(result.eligible).toBe(false);
	});

	it("REVIEW keeps eligibility (inspection emphasis)", () => {
		const result = decideBrowserEligibility({
			project: browserProject,
			mode: "review",
			devRunning: true,
			localUrl: "http://localhost:5173",
			lastEditPath: "src/App.tsx",
		});
		expect(result.eligible).toBe(true);
	});

	it("classifies browser-relevant paths by extension and routes", () => {
		expect(isBrowserRelevantPath("src/components/Player.tsx")).toBe(true);
		expect(isBrowserRelevantPath("src/App.tsx")).toBe(true);
		expect(isBrowserRelevantPath("routes/index.tsx")).toBe(true);
		expect(isBrowserRelevantPath("pages/home.vue")).toBe(true);
		expect(isBrowserRelevantPath("src/styles/app.css")).toBe(true);
		expect(isBrowserRelevantPath("index.html")).toBe(true);
		// Non-frontend files are not relevant.
		expect(isBrowserRelevantPath("src/utils/calc.ts")).toBe(false);
		expect(isBrowserRelevantPath("README.md")).toBe(false);
		expect(isBrowserRelevantPath("server/index.ts")).toBe(false);
	});
});
