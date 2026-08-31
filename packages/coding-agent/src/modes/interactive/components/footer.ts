import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { arbitrateCurrentFinding } from "../../../aira/ui/finding.ts";
import { buildFooterSegments, FOOTER_SEPARATOR } from "../../../aira/ui/footer.ts";
import type { WorkbenchFooterSegment } from "../../../aira/ui/types.ts";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";
import { roleColor } from "../workbench/workbench-component.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export { formatTokens } from "../../../aira/ui/footer.ts";

/** Format a cwd under the user's home for footer display. */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Aira Workbench footer — segment-based status rail (Phase 12).
 *
 * One line of responsive segments (mode first, model last); lower-priority
 * segments drop first as width runs out (see aira/ui/footer.ts for the
 * priority model). The single most useful current finding is arbitrated from
 * canonical state and rendered as a compact segment.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.airaSessionState;

		// Context usage from the session (handles compaction correctly).
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? this.session.state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		const finding = arbitrateCurrentFinding(state);

		const model = this.session.state.model;
		const thinkingLevel = model?.reasoning ? this.session.thinkingLevel : undefined;

		const { left, right } = buildFooterSegments({
			state,
			finding,
			cwd: this.footerCwd(),
			branch: this.footerData.getGitBranch() ?? undefined,
			context: {
				percent: contextPercent,
				window: contextWindow,
				autoCompact: this.autoCompactEnabled,
				over90: contextPercentValue > 90,
				over70: contextPercentValue > 70,
			},
			modelId: model?.id ?? "no-model",
			thinkingLevel: thinkingLevel === "off" ? undefined : thinkingLevel,
		});

		const line = composeFooter(left, right, width);

		// Extension statuses stay on their own line when present (extension
		// compatibility contract; never mixed into the priority rail).
		const extensionStatuses = this.footerData.getExtensionStatuses();
		const lines = [line];
		if (extensionStatuses.size > 0) {
			const statusLine = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join(" ");
			lines.push(truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "...")));
		}
		return lines;
	}

	private footerCwd(): string {
		return formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
	}
}

function segmentText(segment: WorkbenchFooterSegment): string {
	return roleColor(segment.role, segment.text);
}

/** Compose footer segments into one line with left/right balancing. */
export function composeFooter(
	left: readonly WorkbenchFooterSegment[],
	right: readonly WorkbenchFooterSegment[],
	width: number,
): string {
	const separator = ` ${theme.fg("dim", FOOTER_SEPARATOR)} `;
	const leftText = left.map(segmentText).join(separator);
	const rightText = right.map(segmentText).join(separator);
	const leftWidth = visibleWidth(leftText);
	const rightWidth = visibleWidth(rightText);
	const gap = width - leftWidth - rightWidth;
	if (leftText && rightText && gap >= 2) {
		return `${leftText}${" ".repeat(gap)}${rightText}`;
	}
	const joined = [leftText, rightText].filter(Boolean).join(" · ");
	return truncateToWidth(joined, width, "");
}
