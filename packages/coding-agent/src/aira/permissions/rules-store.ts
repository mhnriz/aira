/**
 * Aira permissions — persistent rule store.
 *
 * Persistent permission rules live in Aira-owned canonical config:
 * `~/.aira/agent/permissions.json` (NOT Pi-owned config, never project-
 * local: a repository cannot silently grant itself privileges — project
 * config is not read at all in Phase 11, documented).
 *
 * The store is bounded and validated: rules are normalized on load (a
 * corrupt or oversized file degrades to an empty rule list + a truthful
 * health record, never a crash), and writes are atomic-ish (temp file +
 * rename). Everything here degrades to ordinary usable Aira.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAiraAgentDir, getAiraHome } from "../paths.ts";
import { normalizeAiraPermissionRules } from "./policy.ts";
import {
	AIRA_PERMISSION_MAX_RULES,
	AIRA_PERMISSION_STORE_VERSION,
	type AiraPermissionRule,
	type AiraPermissionStoreHealth,
	type AiraPersistedPermissionRules,
} from "./types.ts";

const MAX_FILE_BYTES = 256 * 1024;

export interface AiraPermissionRuleStore {
	/** Load persistent rules; [] when absent/unreadable (never throws). */
	load(): { rules: AiraPermissionRule[]; health: AiraPermissionStoreHealth };
	/** Persist the full persistent rule list (atomic-ish). Returns health. */
	save(rules: readonly AiraPermissionRule[]): AiraPermissionStoreHealth;
	/** List rule ids currently on disk (for removal UX). */
	listIds(): string[];
	/** Display path. */
	readonly path: string;
}

export function createAiraPermissionRuleStore(options: { baseDir?: string } = {}): AiraPermissionRuleStore {
	const baseDir = options.baseDir ?? getAiraAgentDir();
	const path = join(baseDir, "permissions.json");

	const load = (): { rules: AiraPermissionRule[]; health: AiraPermissionStoreHealth } => {
		if (!existsSync(path)) {
			return { rules: [], health: { status: "unavailable", path: displayPath(path), error: undefined } };
		}
		try {
			const raw = readFileSync(path, "utf8");
			if (raw.length > MAX_FILE_BYTES) {
				return {
					rules: [],
					health: { status: "failed", path: displayPath(path), error: "permissions.json exceeds the size bound" },
				};
			}
			const parsed = JSON.parse(raw) as Partial<AiraPersistedPermissionRules>;
			if (!parsed || typeof parsed !== "object" || parsed.version !== AIRA_PERMISSION_STORE_VERSION) {
				return {
					rules: [],
					health: {
						status: "failed",
						path: displayPath(path),
						error: "permissions.json has an unsupported version",
					},
				};
			}
			const rules = normalizeAiraPermissionRules(parsed.rules, "persistent", AIRA_PERMISSION_MAX_RULES);
			return {
				rules,
				health: { status: "ok", path: displayPath(path), error: undefined },
			};
		} catch (error) {
			return {
				rules: [],
				health: {
					status: "failed",
					path: displayPath(path),
					error: `permissions.json unreadable: ${error instanceof Error ? error.message : String(error)}`,
				},
			};
		}
	};

	const save = (rules: readonly AiraPermissionRule[]): AiraPermissionStoreHealth => {
		const bounded = normalizeAiraPermissionRules(
			rules.slice(0, AIRA_PERMISSION_MAX_RULES).map((rule) => ({ ...rule })),
			"persistent",
			AIRA_PERMISSION_MAX_RULES,
		);
		const payload: AiraPersistedPermissionRules = {
			version: AIRA_PERMISSION_STORE_VERSION,
			rules: bounded.map(({ id, tool, subject, match, action, createdAt, note }) => ({
				id,
				tool,
				subject,
				match,
				action,
				createdAt,
				...(note ? { note } : {}),
			})),
		};
		try {
			mkdirSync(dirname(path), { recursive: true });
			const tmp = `${path}.tmp-${process.pid}`;
			writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
			renameSync(tmp, path);
			return { status: "ok", path: displayPath(path), error: undefined };
		} catch (error) {
			return {
				status: "failed",
				path: displayPath(path),
				error: `permissions.json write failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	};

	const listIds = (): string[] => load().rules.map((rule) => rule.id);

	return { load, save, listIds, path };
}

function displayPath(path: string): string {
	const home = getAiraHome();
	if (path.startsWith(home)) {
		return `~/.aira${path.slice(home.length)}`;
	}
	return path;
}
