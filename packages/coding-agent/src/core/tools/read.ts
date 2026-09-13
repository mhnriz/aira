import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	fingerprintsMatch,
	type RepositoryFileFingerprint,
	type RepositoryObservationStore,
} from "../repository-observations.ts";
import { buildCompactRow, type CompactStatus, compactStatusGlyph } from "./compact.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/** Stat the file for cheap freshness checks. Omit to disable observation reuse. */
	stat?: (absolutePath: string) => Promise<RepositoryFileFingerprint>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: async (path) => {
		const stats = await fsStat(path);
		return { isFile: stats.isFile(), mtimeMs: stats.mtimeMs, size: stats.size };
	},
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Session-local repository observations, used to avoid provably redundant reads. */
	observations?: RepositoryObservationStore;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

/**
 * Compact read row: status glyph + path (or the existing skill/docs/resource
 * classification format). The full file content is never shown collapsed.
 */
function formatCompactReadRow(
	status: CompactStatus,
	args: ReadRenderArgs | undefined,
	theme: Theme,
	cwd: string,
): string {
	const classification = getCompactReadClassification(args, cwd);
	const glyph = compactStatusGlyph(status, theme);
	if (classification) {
		return `${glyph} ${formatCompactReadCall(classification, args, theme)}`;
	}
	const rawPath = str(args?.file_path ?? args?.path);
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	const excerpt: string[] = [];
	const range = formatReadLineRange(args, theme);
	if (range) excerpt.push(range);
	return buildCompactRow(theme, {
		status,
		label: "read",
		targetText: pathDisplay,
		excerpt,
	});
}

function formatReadTruncationNotice(truncation: TruncationResult): string[] {
	if (truncation.firstLineExceedsLimit) {
		return [`[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`];
	}
	if (truncation.truncatedBy === "lines") {
		return [
			`[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
		];
	}
	return [
		`[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
	];
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		for (const notice of formatReadTruncationNotice(truncation)) {
			text += `\n${theme.fg("warning", notice)}`;
		}
	}
	return text;
}

interface TextReadRegion {
	/** Available lines, starting at `regionStart`. */
	lines: string[];
	/** Absolute 0-based index of the first available line. */
	regionStart: number;
	/** Total line count of the whole file. */
	totalFileLines: number;
}

interface TextReadRender {
	outputText: string;
	details: ReadToolDetails | undefined;
	/** Absolute 0-based index of the first retained line. */
	retainedStart: number;
	/** Retained lines at `retainedStart`; 0 when nothing is safe to reuse. */
	retainedCount: number;
	/** Whether the retained region reaches the end of the file. */
	reachesEof: boolean;
}

/**
 * Render a text read from a contiguous line region.
 *
 * A physical read passes the whole file (`regionStart` 0); an observation reuse
 * passes a retained sub-region. Both run the same offset, limit, truncation and
 * continuation-notice logic, so a reused read is byte-for-byte the read the
 * filesystem would have produced.
 */
function renderTextRead(
	region: TextReadRegion,
	offset: number | undefined,
	limit: number | undefined,
	path: string,
): TextReadRender {
	const { lines, regionStart, totalFileLines } = region;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= totalFileLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
	}
	const localStart = startLine - regionStart;
	if (localStart < 0 || localStart >= lines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
	}
	let selectedContent: string;
	let userLimitedLines: number | undefined;
	let selectedLines: number;
	// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, totalFileLines);
		const localEnd = Math.min(endLine - regionStart, lines.length);
		selectedContent = lines.slice(localStart, localEnd).join("\n");
		userLimitedLines = endLine - startLine;
		selectedLines = localEnd - localStart;
	} else {
		selectedContent = lines.slice(localStart).join("\n");
		selectedLines = lines.length - localStart;
	}
	// Apply truncation, respecting both line and byte limits.
	const truncation = truncateHead(selectedContent);
	let outputText: string;
	let details: ReadToolDetails | undefined;
	let retainedCount: number;
	let reachesEof: boolean;
	if (truncation.firstLineExceedsLimit) {
		// First line alone exceeds the byte limit. Point the model at a bash fallback.
		const firstLineSize = formatSize(Buffer.byteLength(lines[localStart], "utf-8"));
		outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
		details = { truncation };
		retainedCount = 0;
		reachesEof = false;
	} else if (truncation.truncated) {
		// Truncation occurred. Build an actionable continuation notice.
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		details = { truncation };
		retainedCount = truncation.outputLines;
		reachesEof = false;
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
		// User-specified limit stopped early, but the file still has more content.
		const remaining = totalFileLines - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
		retainedCount = selectedLines;
		reachesEof = false;
	} else {
		// No truncation and no remaining user-limited content.
		outputText = truncation.content;
		retainedCount = selectedLines;
		reachesEof = startLine + selectedLines >= totalFileLines;
	}
	return { outputText, details, retainedStart: startLine, retainedCount, reachesEof };
}

async function statFingerprint(
	stat: (absolutePath: string) => Promise<RepositoryFileFingerprint>,
	absolutePath: string,
): Promise<RepositoryFileFingerprint | undefined> {
	try {
		return await stat(absolutePath);
	} catch {
		return undefined;
	}
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, { autoResizeImages });
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content. Reuse a fresh observation when it provably
								// still describes the current file version; otherwise read.
								const observations = options?.observations;
								const observationKey = observations?.observationKey(path, ctx?.cwd || cwd);
								const beforeFingerprint =
									observations && ops.stat ? await statFingerprint(ops.stat, absolutePath) : undefined;
								if (aborted) return;
								const observation = observationKey
									? observations?.lookup(observationKey, beforeFingerprint, { offset, limit })
									: undefined;
								if (observation) {
									const rendered = renderTextRead(
										{
											lines: observation.lines,
											regionStart: observation.startLine,
											totalFileLines: observation.totalFileLines,
										},
										offset,
										limit,
										path,
									);
									content = [{ type: "text", text: rendered.outputText }];
									details = rendered.details;
								} else {
									const buffer = await ops.readFile(absolutePath);
									if (aborted) return;
									const textContent = buffer.toString("utf-8");
									const allLines = textContent.split("\n");
									const rendered = renderTextRead(
										{ lines: allLines, regionStart: 0, totalFileLines: allLines.length },
										offset,
										limit,
										path,
									);
									content = [{ type: "text", text: rendered.outputText }];
									details = rendered.details;
									if (observations && observationKey && ops.stat && rendered.retainedCount > 0) {
										const afterFingerprint = await statFingerprint(ops.stat, absolutePath);
										if (
											beforeFingerprint &&
											afterFingerprint &&
											fingerprintsMatch(beforeFingerprint, afterFingerprint)
										) {
											observations.record(
												observationKey,
												{
													path: absolutePath,
													startLine: rendered.retainedStart,
													lines: allLines.slice(
														rendered.retainedStart,
														rendered.retainedStart + rendered.retainedCount,
													),
													totalFileLines: allLines.length,
													reachesEof: rendered.reachesEof,
												},
												afterFingerprint,
											);
										}
									}
								}
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (!context.expanded) {
				// Compact: the result renderer owns the row once a result exists.
				if (context.hasResult) {
					text.setText("");
					return text;
				}
				text.setText(
					formatCompactReadRow(
						context.isError ? "error" : context.isPartial ? "running" : "success",
						args as ReadRenderArgs | undefined,
						theme,
						context.cwd,
					),
				);
				return text;
			}
			const classification = getCompactReadClassification(args, context.cwd);
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (!context.expanded) {
				const status: CompactStatus = context.isError ? "error" : options.isPartial ? "running" : "success";
				const lines = [
					formatCompactReadRow(status, context.args as ReadRenderArgs | undefined, theme, context.cwd),
				];
				if (context.isError) {
					const output = getTextOutput(result, context.showImages);
					const errorLines = output.split("\n").map((line) => line.trimEnd());
					while (errorLines.length > 0 && errorLines[errorLines.length - 1] === "") {
						errorLines.pop();
					}
					const tail = errorLines.slice(-6);
					if (errorLines.length > tail.length && tail.length > 0) {
						lines.push(
							theme.fg("muted", `... (${errorLines.length - tail.length} earlier lines,`) +
								` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
						);
					}
					for (const line of tail) {
						lines.push(theme.fg("error", line));
					}
				} else if (!options.isPartial) {
					const truncation = result.details?.truncation;
					if (truncation?.truncated) {
						for (const notice of formatReadTruncationNotice(truncation)) {
							lines.push(theme.fg("warning", notice));
						}
					}
				}
				text.setText(lines.join("\n"));
				return text;
			}
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
