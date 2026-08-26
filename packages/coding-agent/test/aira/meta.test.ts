import { describe, expect, it } from "vitest";
import {
	AIRA_HOME_DIR_NAME,
	AIRA_PACKAGE_NAME,
	AIRA_PI_BASE_VERSION,
	AIRA_PRODUCT_NAME,
	AIRA_PRODUCT_TITLE,
	AIRA_VERSION,
	formatAiraShortVersion,
	formatAiraVersion,
} from "../../src/aira/meta.ts";
import { VERSION } from "../../src/config.ts";

describe("Aira product metadata", () => {
	it("keeps the Pi-derived package identity intact for compatibility", () => {
		expect(AIRA_PRODUCT_NAME).toBe("aira");
		expect(AIRA_HOME_DIR_NAME).toBe(".aira");
		expect(AIRA_PACKAGE_NAME).toBe("@earendil-works/pi-coding-agent");
		expect(AIRA_PI_BASE_VERSION).toBe(VERSION);
	});

	it("versions Aira independently from Pi", () => {
		expect(AIRA_PRODUCT_TITLE).toBe("Aira");
		expect(AIRA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(`${AIRA_PRODUCT_TITLE} ${AIRA_VERSION}`).not.toBe(`Pi ${AIRA_PI_BASE_VERSION}`);
	});

	it("formats the full and short version strings", () => {
		expect(formatAiraVersion()).toBe(`Aira ${AIRA_VERSION} (Pi base ${AIRA_PI_BASE_VERSION})`);
		expect(formatAiraShortVersion()).toBe(`Aira ${AIRA_VERSION}`);
	});
});
