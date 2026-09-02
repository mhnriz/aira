/**
 * Aira permission card — the interactive permission selector.
 *
 * Renders the canonical Phase 11 permission presentation (see
 * src/aira/permissions/presentation.ts) as an Aira-native card:
 *
 *   PERMISSION
 *   Shell command
 *   $ git push --dry-run origin main
 *
 *   Working directory   ~/proj/aira
 *   Reason              remote repository operation
 *
 *   › Allow once        Run only this request
 *     Allow session     Approve this exact subject for this session
 *     Allow always      Persist approval for this exact subject
 *     Deny              Do not execute
 *
 *   ↑↓ navigate   enter select   esc cancel
 *
 * The card is a PROJECTION ONLY: answering maps a choice id back through
 * the existing interaction bridge; the canonical manager stays the owner
 * of permission state, decision mapping, timeout, and cancellation
 * semantics. The card is only ever instantiated by the interactive mode
 * dialog (headless/SDK/RPC never construct it).
 *
 * Color contract (aira-zhr semantics): copper heading + border, copperBright
 * operation and focused choice, ivory (text) subject, muted metadata labels,
 * yellow reason, red deny label, muted key hints. Rendering is token-free;
 * every dynamic line wraps/truncates to the render width with an explicit
 * "…" indicator, so narrow terminals stay readable.
 */

import {
	type Component,
	Container,
	getKeybindings,
	sliceByColumn,
	Text,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AiraPermissionPresentation } from "../../../aira/permissions/presentation.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface PermissionCardChoice {
	id: string;
	label: string;
	description?: string;
}

export interface PermissionCardOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
}

/** Cursor before the focused choice. */
const CURSOR = "›";

/** Metadata label column width (label + gap). */
const LABEL_COLUMN = 20;

/** Choice label column width before the description. */
const CHOICE_LABEL_COLUMN = 18;

/** Subject block: at most this many visual lines. */
const SUBJECT_MAX_LINES = 3;

/** Metadata/choice lines: one visual line each, truncated with "…". */
const ROW_MAX_LINES = 1;

/** Horizontal padding inside the card (matches the selector dialogs). */
const PAD_X = 1;

export class PermissionCardComponent extends Container {
	private readonly presentation: AiraPermissionPresentation;
	private readonly choices: readonly PermissionCardChoice[];
	private selectedIndex = 0;
	private readonly onSelectCallback: (choiceId: string) => void;
	private readonly onCancelCallback: () => void;
	private readonly onToggleToolsExpanded: (() => void) | undefined;
	private readonly titleText: Text;
	private readonly reasonText: Text;
	private readonly subjectText: Text;
	private readonly detailTexts: Text[];
	private readonly choiceTexts: Text[];
	private readonly countdown: CountdownTimer | undefined;
	private lastWidth = 80;

	constructor(
		presentation: AiraPermissionPresentation,
		choices: readonly PermissionCardChoice[],
		onSelect: (choiceId: string) => void,
		onCancel: () => void,
		opts?: PermissionCardOptions,
	) {
		super();
		this.presentation = presentation;
		this.choices = choices;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;

		this.addChild(new DynamicBorder((str) => theme.fg("copper", str)));
		this.addChild(spacerLine());

		this.titleText = new Text(theme.fg("copper", theme.bold("PERMISSION")), PAD_X, 0);
		this.addChild(this.titleText);

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("copper", theme.bold(`PERMISSION (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.addChild(new Text(theme.fg("copperBright", presentation.operation), PAD_X, 0));
		this.addChild(spacerLine());

		this.subjectText = new Text("", PAD_X, 0);
		this.addChild(this.subjectText);
		this.addChild(spacerLine());

		this.detailTexts = presentation.details.map(() => new Text("", PAD_X, 0));
		for (const detail of this.detailTexts) {
			this.addChild(detail);
		}
		this.reasonText = new Text("", PAD_X, 0);
		this.addChild(this.reasonText);
		this.addChild(spacerLine());

		this.choiceTexts = choices.map(() => new Text("", PAD_X, 0));
		for (const choice of this.choiceTexts) {
			this.addChild(choice);
		}
		this.addChild(spacerLine());
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				PAD_X,
				0,
			),
		);
		this.addChild(spacerLine());
		this.addChild(new DynamicBorder((str) => theme.fg("copper", str)));
	}

	render(width: number): string[] {
		this.refreshDynamic(width);
		return super.render(width);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.refreshDynamic(this.lastWidth);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.choices.length - 1, this.selectedIndex + 1);
			this.refreshDynamic(this.lastWidth);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const choice = this.choices[this.selectedIndex];
			if (choice) this.onSelectCallback(choice.id);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}

	private refreshDynamic(width: number): void {
		this.lastWidth = width;
		const contentWidth = Math.max(1, width - PAD_X * 2);
		this.subjectText.setText(this.boundedSubject(contentWidth));
		for (let i = 0; i < this.detailTexts.length; i++) {
			const row = this.presentation.details[i]!;
			this.detailTexts[i]!.setText(this.metadataLine(row.label, row.value, contentWidth, false));
		}
		this.reasonText.setText(this.metadataLine("Reason", this.presentation.reason, contentWidth, true));
		for (let i = 0; i < this.choiceTexts.length; i++) {
			this.choiceTexts[i]!.setText(this.choiceLine(i, contentWidth));
		}
	}

	/** Subject block: `$ command` for process tools, path/tool otherwise. */
	private boundedSubject(contentWidth: number): string {
		const prefix = this.presentation.capability === "process" ? theme.fg("copper", "$ ") : "";
		const subject = theme.fg("text", this.presentation.subject);
		const redactedNote = this.presentation.redacted ? theme.fg("muted", "  (secrets redacted)") : "";
		return truncateToLines(prefix + subject + redactedNote, contentWidth, SUBJECT_MAX_LINES);
	}

	private metadataLine(label: string, value: string, contentWidth: number, warn: boolean): string {
		const paddedLabel = theme.fg("muted", `${label}${" ".repeat(Math.max(1, LABEL_COLUMN - label.length))}`);
		const coloredValue = warn ? theme.fg("yellow", value) : theme.fg("text", value);
		const valueWidth = Math.max(1, contentWidth - LABEL_COLUMN);
		return `${paddedLabel}${truncateToLines(coloredValue, valueWidth, ROW_MAX_LINES)}`;
	}

	private choiceLine(index: number, contentWidth: number): string {
		const choice = this.choices[index]!;
		const focused = index === this.selectedIndex;
		const deny = choice.id === "deny";
		const marker = focused ? theme.fg("copperBright", `${CURSOR} `) : theme.fg("muted", "  ");
		const labelColor: "copperBright" | "red" | "text" = deny ? "red" : focused ? "copperBright" : "text";
		const label = theme.fg(labelColor, choice.label);
		const paddedLabel = `${label}${" ".repeat(Math.max(1, CHOICE_LABEL_COLUMN - choice.label.length))}`;
		const description = choice.description
			? theme.fg(
					"muted",
					truncateToLines(choice.description, Math.max(1, contentWidth - CHOICE_LABEL_COLUMN - 2), ROW_MAX_LINES),
				)
			: "";
		const line = `${marker}${paddedLabel}${description ? `  ${description}` : ""}`;
		return truncateToLines(line, contentWidth, ROW_MAX_LINES);
	}
}

function spacerLine(): Component {
	return {
		invalidate: () => {},
		render: (width: number) => [" ".repeat(width)],
	};
}

/**
 * Wrap ANSI text and keep at most `maxLines` visual lines. When the text
 * overflows, the last kept line is cut so the explicit "…" indicator stays
 * ON that line (ANSI-safe slicing; the TUI re-wraps the result, so the
 * bounded width must include the marker).
 */
function truncateToLines(text: string, width: number, maxLines: number): string {
	if (width <= 0 || text === "") {
		return text;
	}
	const lines = wrapTextWithAnsi(text, width);
	if (lines.length <= maxLines) {
		return lines.join("\n");
	}
	const kept = lines.slice(0, maxLines);
	const joined = kept.slice(0, -1).join("\n");
	const last = kept[maxLines - 1]!;
	// Slice the last kept line to leave room for the marker (ANSI-safe), then
	// append it explicitly — the marker must stay on the cut line.
	const lastCut = `${sliceByColumn(last, 0, Math.max(1, width - 1), true)}…`;
	return `${joined}${maxLines > 1 ? "\n" : ""}${lastCut}`;
}
