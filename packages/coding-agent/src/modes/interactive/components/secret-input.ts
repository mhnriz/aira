/** Local-only masked input for process authentication. */

import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface SecretInputOptions {
	tui?: TUI;
	timeout?: number;
}

/**
 * A dedicated local secret editor. The underlying Input is never rendered;
 * only a fixed-width mask is rendered. The value is cleared before the
 * completion/cancellation callback returns to the UI layer.
 */
export class SecretInputComponent extends Container implements Focusable {
	private readonly input = new Input();
	private readonly maskedValue: Text;
	private readonly titleText: Text;
	private readonly baseTitle: string;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onCancelCallback: () => void;
	private readonly countdown: CountdownTimer | undefined;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		prompt: string,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: SecretInputOptions,
	) {
		super();
		this.baseTitle = "AUTHENTICATION REQUIRED";
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder((str) => theme.fg("copper", str)));
		this.addChild(new Spacer(1));
		this.titleText = new Text(theme.fg("copper", theme.bold(this.baseTitle)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("text", prompt), 1, 0));
		this.addChild(new Spacer(1));
		this.maskedValue = new Text("", 1, 0);
		this.addChild(this.maskedValue);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(`${keyHint("tui.select.confirm", "authenticate")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((str) => theme.fg("copper", str)));

		this.input.onSubmit = () => this.submit();
		this.input.onEscape = () => this.cancel();
		if (options?.timeout && options.timeout > 0) {
			this.countdown = new CountdownTimer(
				options.timeout,
				tui,
				(seconds) => this.titleText.setText(theme.fg("copper", theme.bold(`${this.baseTitle} (${seconds}s)`))),
				() => this.cancel(),
			);
		}
		this.refreshMask();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.submit();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		this.input.handleInput(data);
		this.refreshMask();
	}

	dispose(): void {
		this.countdown?.dispose();
		this.input.setValue("");
		this.maskedValue.setText("");
	}

	private submit(): void {
		const value = this.input.getValue();
		this.input.setValue("");
		this.maskedValue.setText("");
		this.onSubmitCallback(value);
	}

	private cancel(): void {
		this.input.setValue("");
		this.maskedValue.setText("");
		this.onCancelCallback();
	}

	private refreshMask(): void {
		const count = [...this.input.getValue()].length;
		this.maskedValue.setText(theme.fg("text", count > 0 ? "•".repeat(count) : "(empty)"));
	}
}
