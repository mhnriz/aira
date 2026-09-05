/** Read-only, bounded Git checkpoint inspection for the Workbench. */

import { execFile } from "node:child_process";
import type { WorkbenchCheckpoint } from "./types.ts";

const CHECKPOINT_LIMIT = 5;
const CHECKPOINT_TIMEOUT_MS = 800;

export function loadWorkbenchCheckpoints(cwd: string): Promise<WorkbenchCheckpoint[]> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["--no-optional-locks", "log", `-${CHECKPOINT_LIMIT}`, "--pretty=format:%h%x09%s"],
			{ cwd, encoding: "utf8", timeout: CHECKPOINT_TIMEOUT_MS, maxBuffer: 32_000 },
			(error, stdout) => {
				if (error) {
					resolve([]);
					return;
				}
				const rows = stdout
					.split("\n")
					.map((line, index) => {
						const [hash, ...subjectParts] = line.trim().split("\t");
						return {
							hash: hash ?? "?",
							subject: subjectParts.join("\t").slice(0, 100),
							head: index === 0,
							dirty: false,
						};
					})
					.filter((row) => row.hash.length > 0 && row.hash !== "?")
					.slice(0, CHECKPOINT_LIMIT);
				readDirty(cwd).then((dirty) => resolve(rows.map((row) => ({ ...row, dirty }))));
			},
		);
	});
}

function readDirty(cwd: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["--no-optional-locks", "status", "--short"],
			{ cwd, encoding: "utf8", timeout: CHECKPOINT_TIMEOUT_MS, maxBuffer: 32_000 },
			(error, stdout) => resolve(!error && stdout.trim().length > 0),
		);
	});
}
