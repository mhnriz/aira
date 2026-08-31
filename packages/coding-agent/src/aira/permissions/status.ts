/**
 * Aira permissions — restrained summaries for `/status`, `/permissions`,
 * and `/doctor`. Token-free projections of the canonical `state.permissions`
 * snapshot; rendering never evaluates a request.
 */
import type { AiraPermissionRule, AiraPermissionStatus } from "./types.ts";

/** Bounded report for the `/permissions` command (status surface). */
export function formatAiraPermissionsReport(permissions: AiraPermissionStatus | undefined): string {
	if (!permissions) {
		return ["permissions: unavailable", "  (no canonical snapshot — controller wiring)"].join("\n");
	}
	const lines = [
		`permissions: ${permissions.enabled ? `enabled · mode ${permissions.mode}` : "disabled"}`,
		`rules: ${permissions.persistentRules} persistent · ${permissions.sessionRules} session · ${permissions.onceApprovals} one-time`,
		`store: ${permissions.store.status}${permissions.store.error ? ` (${permissions.store.error})` : ""}${permissions.store.path ? ` · ${permissions.store.path}` : ""}`,
	];
	if (permissions.lastDecision) {
		lines.push(
			`last decision: ${permissions.lastDecision.tool} → ${permissions.lastDecision.action}${permissions.lastDecision.subject ? ` · ${permissions.lastDecision.subject}` : ""}`,
		);
	}
	lines.push(
		"modes: normal (ask on risky/out-of-scope/unknown) · permissive (auto-approve normal asks) · strict (deny-unapproved) · yolo (bypass; explicit deny + PLAN absolute)",
	);
	return lines.join("\n");
}

/** Bounded rule listing for `/permissions rule list`. */
export function formatAiraPermissionRules(
	session: readonly AiraPermissionRule[],
	persistent: readonly AiraPermissionRule[],
): string {
	const lines: string[] = ["permission rules"];
	const render = (rule: AiraPermissionRule): string => {
		const match = rule.match === "wildcard" ? ` ~${rule.subject}` : ` =${rule.subject}`;
		const note = rule.note ? ` (${rule.note})` : "";
		return `- ${rule.id} ${rule.tool}${match} ${rule.action} [${rule.scope}]${note}`;
	};
	if (persistent.length === 0 && session.length === 0) {
		lines.push("(no rules — mode defaults apply)");
		return lines.join("\n");
	}
	for (const rule of persistent) {
		lines.push(render(rule));
	}
	for (const rule of session) {
		lines.push(render(rule));
	}
	return lines.join("\n");
}
