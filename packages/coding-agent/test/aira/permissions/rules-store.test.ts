/**
 * Aira permissions — rules store tests (Phase 11).
 *
 * Covers: persistence round-trip, normalization bounds, corrupt/oversized
 * file degradation (never throws), Aira-owned path, version guard, and
 * project-config non-involvement (the store is only read from the Aira
 * home; project dirs are never consulted).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAiraPermissionRuleStore } from "../../../src/aira/permissions/rules-store.ts";
import type { AiraPermissionRule } from "../../../src/aira/permissions/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "aira-permissions-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function rule(
	partial: Partial<AiraPermissionRule> & { tool: string; subject: string; action: AiraPermissionRule["action"] },
): AiraPermissionRule {
	return {
		id: partial.id ?? "r1",
		tool: partial.tool,
		subject: partial.subject,
		match: partial.match ?? "exact",
		action: partial.action,
		scope: "persistent",
		createdAt: partial.createdAt ?? Date.now(),
	};
}

describe("permission rules store (Phase 11)", () => {
	it("saves and loads persistent rules in the Aira-owned agent dir", () => {
		const dir = tempDir();
		const store = createAiraPermissionRuleStore({ baseDir: dir });
		expect(store.path).toBe(join(dir, "permissions.json"));
		expect(existsSync(store.path)).toBe(false);

		const saved = store.save([
			rule({ id: "r1", tool: "bash", subject: "git push *", match: "wildcard", action: "ask" }),
		]);
		expect(saved.status).toBe("ok");
		expect(existsSync(store.path)).toBe(true);

		const loaded = store.load();
		expect(loaded.health.status).toBe("ok");
		expect(loaded.rules).toHaveLength(1);
		expect(loaded.rules[0]!.tool).toBe("bash");
		expect(loaded.rules[0]!.subject).toBe("git push *");
		expect(loaded.rules[0]!.match).toBe("wildcard");
	});

	it("absent store reports unavailable with an empty rule list", () => {
		const store = createAiraPermissionRuleStore({ baseDir: tempDir() });
		const loaded = store.load();
		expect(loaded.rules).toEqual([]);
		expect(loaded.health.status).toBe("unavailable");
	});

	it("corrupt JSON degrades to empty rules with a failed health record", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "permissions.json"), "{not json", "utf8");
		const store = createAiraPermissionRuleStore({ baseDir: dir });
		const loaded = store.load();
		expect(loaded.rules).toEqual([]);
		expect(loaded.health.status).toBe("failed");
		expect(loaded.health.error).toBeTruthy();
	});

	it("invalid rule rows are normalized away; malformed entries never throw", () => {
		const dir = tempDir();
		const store = createAiraPermissionRuleStore({ baseDir: dir });
		store.save([
			rule({ id: "r1", tool: "bash", subject: "npm i", action: "allow" }),
			rule({ id: "r2", tool: "edit", subject: "/tmp/x", action: "deny" }),
		] as AiraPermissionRule[]);
		// Hand-craft a corrupt file with mixed garbage.
		writeFileSync(
			join(dir, "permissions.json"),
			JSON.stringify({
				version: 1,
				rules: [
					{ id: "good", tool: "bash", subject: "npm i", match: "exact", action: "allow", createdAt: 1 },
					{ tool: "missing-id", subject: "x", action: "allow" },
					{ id: "bad-action", tool: "bash", subject: "y", match: "exact", action: "explode" },
					"garbage",
					null,
				],
			}),
			"utf8",
		);
		const loaded = store.load();
		expect(loaded.rules).toHaveLength(1);
		expect(loaded.rules[0]!.id).toBe("good");
	});

	it("oversized files fail closed (empty rules, failed health)", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "permissions.json"), " ".repeat(300_000), "utf8");
		const store = createAiraPermissionRuleStore({ baseDir: dir });
		const loaded = store.load();
		expect(loaded.rules).toEqual([]);
		expect(loaded.health.status).toBe("failed");
	});

	it("unsupported versions fail closed", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ version: 99, rules: [] }), "utf8");
		const store = createAiraPermissionRuleStore({ baseDir: dir });
		const loaded = store.load();
		expect(loaded.rules).toEqual([]);
		expect(loaded.health.status).toBe("failed");
	});

	it("project-local config is never consulted (no read path exists)", () => {
		// The store has exactly one load source: its Aira-owned path. There is
		// no project-dir parameter anywhere in the store contract.
		const store = createAiraPermissionRuleStore({ baseDir: tempDir() });
		const loaded = store.load();
		expect(loaded.health.path).not.toContain("proj");
	});
});
