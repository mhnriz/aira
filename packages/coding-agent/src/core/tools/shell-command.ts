/**
 * Shell command classification for test / check / build purposes.
 *
 * Extracted from the compact tool renderer so that non-UI consumers (the
 * session telemetry collector) can reuse the same purpose taxonomy without
 * depending on the interactive theme layer. Classification is lexical and
 * cheap: strip a package-manager / `run` wrapper, then match the resulting
 * subcommand against the validation vocabulary.
 */

export type ShellPurposeKind = "bash" | "test" | "check" | "build";

const TEST_COMMAND_RE =
	/^(?:(?:\.\/|\.\\)?test(?:\.[a-z]+)?|vitest|jest|karma|mocha|pytest|go\s+test|cargo\s+test|node\s+--test|tsx\s+--test|bun\s+test|deno\s+test)\b/;
const CHECK_COMMAND_RE = /^(?:check|typecheck|lint|tsc\b|biome\s+check|eslint|prettier\s+--?check|biome\s+lint)\b/;
const BUILD_COMMAND_RE = /^(?:build|tsc\s+--?build|bun\s+build|vite\s+build|next\s+build|webpack|rollup|esbuild|swc)\b/;

export interface ShellCommandInfo {
	kind: ShellPurposeKind;
	/** Command as typed, trimmed of surrounding whitespace. */
	display: string;
	/** Test target (last path-looking argument), when useful. */
	target?: string;
}

/** Classify a shell command for the compact row label and target. */
export function classifyShellCommand(command: string): ShellCommandInfo {
	const trimmed = command.trim();
	const normalized = trimmed.replace(/^(npx|npm|bun|pnpm|yarn|deno)\s+/, "").replace(/^(?:run|exec)\s+/, "");
	const rest = normalized.trim();
	// An unwrapped leading `test` is the POSIX conditional (`test -f x`), not a
	// test-runner invocation; wrapped forms (`npm test`, `bun test`) and suffixed
	// forms (`./test.sh`) keep the test purpose.
	const posixConditional = /^test(?:\s|$)/.test(trimmed);
	let kind: ShellPurposeKind = "bash";
	if (!posixConditional && TEST_COMMAND_RE.test(rest)) kind = "test";
	else if (CHECK_COMMAND_RE.test(rest)) kind = "check";
	else if (BUILD_COMMAND_RE.test(rest)) kind = "build";

	let target: string | undefined;
	if (kind === "test") {
		const parts = rest.split(/\s+/).slice(1);
		const lastArg = parts[parts.length - 1];
		if (
			lastArg &&
			!lastArg.startsWith("-") &&
			(lastArg.includes("/") || lastArg.includes("\\") || lastArg.includes("."))
		) {
			target = lastArg;
		}
	}
	return { kind, display: trimmed, target };
}
