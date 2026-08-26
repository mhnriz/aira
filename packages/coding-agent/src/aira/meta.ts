/**
 * Aira core — product metadata.
 *
 * Aira versions itself independently from the Pi-derived package underneath
 * ("Aira 0.1.0", Pi base 0.84.3). The package machinery stays Pi-compatible:
 * `PACKAGE_NAME` and `VERSION` remain the upstream package identity so Pi
 * tooling, extensions, and upstream syncs keep working. Aira's own identity,
 * version, and home are the product surface and live here.
 */
import { CONFIG_DIR_NAME, PACKAGE_NAME, VERSION } from "../config.ts";

/** Canonical executable/product name (matches piConfig.name). */
export const AIRA_PRODUCT_NAME = "aira";
/** Display title used in user-facing product surface. */
export const AIRA_PRODUCT_TITLE = "Aira";
/** Aira's own product version, independent of the Pi-derived package version. */
export const AIRA_VERSION = "0.1.0";
/** Aira home directory name (matches piConfig.configDir). */
export const AIRA_HOME_DIR_NAME = CONFIG_DIR_NAME;
/** The Pi-derived package this build is based on. */
export const AIRA_PACKAGE_NAME = PACKAGE_NAME;
/** The Pi-derived package version this build is based on. */
export const AIRA_PI_BASE_VERSION = VERSION;

/** Single-line product version string, e.g. "Aira 0.1.0 (Pi base 0.84.3)". */
export function formatAiraVersion(): string {
	return `${AIRA_PRODUCT_TITLE} ${AIRA_VERSION} (Pi base ${AIRA_PI_BASE_VERSION})`;
}

/** Short identity line for status/UX, e.g. "Aira 0.1.0". */
export function formatAiraShortVersion(): string {
	return `${AIRA_PRODUCT_TITLE} ${AIRA_VERSION}`;
}
