/**
 * Aira tasks — restrained summaries for `/status`, `/tasks`, and `/doctor`.
 *
 * Token-free projections of the canonical `state.tasks` snapshot. `/tasks`
 * renders a bounded grouped report from the task manager (the live session
 * source); the full Workbench projection is a later UI phase (UI_BACKLOG).
 */
import type { AiraTask, AiraTasksStatus } from "./types.ts";

/** Bounded report for the `/tasks` command (status surface). */
export function formatAiraTasksReport(tasks: AiraTasksStatus | undefined): string {
	if (!tasks) {
		return "tasks: unavailable";
	}
	if (!tasks.enabled) {
		return "tasks: disabled (tasks.enabled=false)";
	}
	const lines = [
		`tasks: ${tasks.summary}`,
		`counts: ${tasks.total} total · ${tasks.pending} pending · ${tasks.active} active · ${tasks.blocked} blocked · ${tasks.completed} completed · ${tasks.cancelled} cancelled · ${tasks.failed} failed`,
	];
	if (tasks.current) {
		lines.push(`current: ${tasks.current}`);
	}
	for (const row of tasks.rows) {
		const glyph =
			row.status === "completed"
				? "✓"
				: row.status === "active"
					? "◐"
					: row.status === "blocked"
						? "⊘"
						: row.status === "failed"
							? "✕"
							: row.status === "cancelled"
								? "–"
								: "○";
		const source = row.source === "child" ? ` [child${row.childRole ? `:${row.childRole}` : ""}]` : "";
		const deps = row.dependsOn.length > 0 ? ` · deps [${row.dependsOn.join(", ")}]` : "";
		const detail = row.detail ? ` · ${row.detail}` : "";
		lines.push(`  ${glyph} ${row.id} ${row.title} [${row.status}]${source}${deps}${detail}`);
	}
	if (tasks.rows.length === 0) {
		lines.push("  (no tasks yet — ask the agent to use the tasks tool, or use /tasks add <title>)");
	}
	return lines.join("\n");
}

/** Full single-task detail for the `/tasks` surface. */
export function formatAiraTaskDetail(task: AiraTask): string {
	const lines = [`task ${task.id}: ${task.title}`, `status: ${task.status} · source: ${task.source}`];
	if (task.dependsOn.length > 0) {
		lines.push(`depends on: ${task.dependsOn.join(", ")}`);
	}
	if (task.note) {
		lines.push(`note: ${task.note}`);
	}
	if (task.detail) {
		lines.push(`detail: ${task.detail}`);
	}
	if (task.source === "child") {
		lines.push("(orchestration-owned row: lifecycle is managed by /agents; patching is refused)");
	}
	return lines.join("\n");
}
