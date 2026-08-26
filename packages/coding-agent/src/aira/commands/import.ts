/**
 * Aira core — native `import` CLI command.
 *
 * Unnamespaced Aira command (ADR-017). Copies a Pi home into the Aira home on
 * request — migration is optional and explicit:
 *
 * ```text
 * aira import --pi [--include-secrets] [--dry-run] [--force]
 * ```
 *
 * See `migration.ts` for the copy semantics (conservative by default: no
 * secrets, no overwrites).
 */
import chalk from "chalk";
import { APP_NAME } from "../../config.ts";
import {
	getPiAgentDir,
	hasImportablePiHome,
	importPiAgentDir,
	type PiImportAction,
	type PiImportSummary,
} from "../migration.ts";

const IMPORT_USAGE = `${APP_NAME} import --pi [--include-secrets] [--dry-run] [--force]`;

function printImportHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${IMPORT_USAGE}

Import a Pi home (~/.pi/agent) into the Aira home (~/.aira). Aira never reads
~/.pi during normal operation; this is an optional one-time migration.

Options:
  --pi                 Import from the Pi home (~/.pi/agent)
  --include-secrets    Also copy credentials (auth.json)
  --dry-run            Report what would be copied without copying
  --force              Overwrite resources already present in the Aira home
`);
}

function actionLabel(action: PiImportAction): string {
	switch (action) {
		case "copied":
			return chalk.green("copied");
		case "skipped-existing":
			return chalk.yellow("skipped (already present)");
		case "skipped-secrets":
			return chalk.dim("skipped (credentials; use --include-secrets)");
		case "dry-run":
			return chalk.dim("would copy");
		case "missing":
			return chalk.dim("missing");
	}
}

export function printImportSummary(summary: PiImportSummary): void {
	console.log("");
	if (summary.dryRun) {
		console.log(chalk.bold(chalk.yellow("Dry run — no files were copied.")));
	}
	console.log(chalk.bold("Pi home import"));
	console.log(`  source: ${summary.source}`);
	console.log(`  target: ${summary.target}`);
	for (const resource of summary.resources) {
		if (resource.action === "missing") continue;
		console.log(`  ${actionLabel(resource.action).padEnd(34)} ${resource.rel}`);
	}
	console.log("");
	if (summary.markerPath) {
		console.log(chalk.green(`Imported ${summary.copiedCount} resource${summary.copiedCount === 1 ? "" : "s"}.`));
		console.log(chalk.dim(`Recorded in ${summary.markerPath}`));
	} else if (!summary.dryRun) {
		console.log(chalk.dim(`No new resources were imported (copied ${summary.copiedCount}).`));
	}
}

/**
 * Handle the optional Pi migration command. Returns false when `args[0]` is not
 * `import`, true when it is (the command has been handled).
 */
export async function handleImportCommand(args: string[]): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "import") {
		return false;
	}

	if (rest.includes("-h") || rest.includes("--help")) {
		printImportHelp();
		return true;
	}

	let sourceProvided = false;
	let includeSecrets = false;
	let dryRun = false;
	let overwrite = false;
	for (const arg of rest) {
		switch (arg) {
			case "--pi":
				sourceProvided = true;
				break;
			case "--include-secrets":
				includeSecrets = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--force":
				overwrite = true;
				break;
			default:
				console.error(chalk.red(`Unknown option ${arg} for "import".`));
				console.error(chalk.dim(`Use "${APP_NAME} --help" or "${IMPORT_USAGE}".`));
				process.exitCode = 1;
				return true;
		}
	}

	if (!sourceProvided) {
		console.error(chalk.red('No source selected. Use "import --pi" to import from ~/.pi/agent.'));
		console.error(chalk.dim(`Usage: ${IMPORT_USAGE}`));
		process.exitCode = 1;
		return true;
	}

	try {
		if (!hasImportablePiHome()) {
			console.log(chalk.dim(`No importable Pi home found at ${getPiAgentDir()}. Nothing to import.`));
			return true;
		}
		const summary = importPiAgentDir({ includeSecrets, dryRun, overwrite });
		printImportSummary(summary);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown import error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	return true;
}
