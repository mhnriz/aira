/**
 * Aira workspace ownership — deterministic Goal/run change tracking.
 *
 * A dirty workspace is not evidence that the current Goal owns the dirty
 * paths. The tracker captures a baseline at Goal start, records direct edit /
 * write tool success as the owned execution path, and protects every shared
 * or externally appearing path. Destructive repair authorization is therefore
 * host-enforced and conservative; model instructions cannot grant ownership.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AiraChangeFile } from "../verification/eligibility.ts";

const MAX_TRACKED_PATHS = 200;
const MAX_REASON_CHARS = 240;

export interface AiraWorkspaceOwnershipOptions {
	/** Project root used to canonicalize tool paths. */
	cwd: string;
	/** Canonical bounded repository change snapshot. */
	snapshot: () => Promise<AiraChangeFile[] | undefined>;
}

export type AiraWorkspacePathClass = "baseline" | "owned" | "protected" | "unowned" | "unknown";

export interface AiraWorkspaceOwnershipObservation {
	available: boolean;
	baseline: AiraChangeFile[];
	owned: AiraChangeFile[];
	protected: AiraChangeFile[];
	unowned: AiraChangeFile[];
	/** Counts are bounded and intentionally exclude file contents. */
	counts: { baseline: number; owned: number; protected: number; unowned: number };
}

export interface AiraWorkspaceRepairDecision {
	allowed: boolean;
	path?: string;
	reason: string;
}

export interface AiraWorkspaceOwnershipHandle {
	/** Begin a new Goal scope and capture its pre-existing workspace state. */
	beginGoal(): void;
	/** Resolve after the current Goal baseline has been captured. */
	ready?(): Promise<void>;
	/** Record host-observed edit/write success from the current Goal run. */
	applyAgentEvent(event: AgentEvent): void;
	/** Record a successful mutation from a Goal-owned child runner. */
	recordToolMutation(path: string): void;
	/** Classify a fresh repository snapshot for verifier evidence. */
	classify(files: AiraChangeFile[] | undefined): Promise<AiraWorkspaceOwnershipObservation>;
	/** Current bounded counters for status/diagnostic surfaces. */
	observation(): AiraWorkspaceOwnershipObservation;
	/** Host-side guard for a destructive operation targeting one path. */
	authorizeDestructivePath(path: string): Promise<AiraWorkspaceRepairDecision>;
	/** Host-side guard for a destructive shell command. */
	authorizeDestructiveCommand(command: string): Promise<AiraWorkspaceRepairDecision>;
	/** Release in-memory tracking. */
	dispose(): void;
}

interface Fingerprint {
	change: string;
	content: string;
}

interface OwnedPath {
	path: string;
	/** Snapshot after the host-observed edit/write, used to detect later drift. */
	fingerprint: Fingerprint | undefined;
}

export class AiraWorkspaceOwnershipManager implements AiraWorkspaceOwnershipHandle {
	private readonly cwd: string;
	private readonly snapshot: () => Promise<AiraChangeFile[] | undefined>;
	private baseline = new Map<string, AiraChangeFile>();
	private owned = new Map<string, OwnedPath>();
	private protectedPaths = new Set<string>();
	private unownedPaths = new Set<string>();
	private current = new Map<string, AiraChangeFile>();
	private pendingToolPaths = new Map<string, string>();
	private pendingMutations = new Set<string>();
	private ownedFingerprintPromises = new Map<string, Promise<void>>();
	private baselineReady = false;
	private activeGoal = false;
	private generation = 0;
	private disposed = false;
	private baselinePromise: Promise<void> | undefined;

	constructor(options: AiraWorkspaceOwnershipOptions) {
		this.cwd = resolve(options.cwd);
		this.snapshot = options.snapshot;
	}

	beginGoal(): void {
		if (this.disposed) return;
		this.activeGoal = true;
		this.baseline = new Map();
		this.owned.clear();
		this.protectedPaths.clear();
		this.unownedPaths.clear();
		this.current.clear();
		this.pendingToolPaths.clear();
		this.pendingMutations.clear();
		this.baselineReady = false;
		const generation = ++this.generation;
		this.baselinePromise = this.captureBaseline(generation);
	}

	ready(): Promise<void> {
		return this.baselinePromise ?? Promise.resolve();
	}

	applyAgentEvent(event: AgentEvent): void {
		if (this.disposed || !this.activeGoal) return;
		if (event.type === "tool_execution_start") {
			if (event.toolName === "edit" || event.toolName === "write") {
				const path = toolPathFromArgs(event.args);
				if (path) this.pendingToolPaths.set(event.toolCallId, path);
			}
			return;
		}
		if (event.type !== "tool_execution_end") return;
		const path = this.pendingToolPaths.get(event.toolCallId);
		this.pendingToolPaths.delete(event.toolCallId);
		if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
		if (!path) return;
		const relativePath = this.toRelative(path);
		if (!relativePath) return;
		this.recordToolMutation(relativePath);
	}

	recordToolMutation(path: string): void {
		if (this.disposed || !this.activeGoal) return;
		const relativePath = this.toRelative(path);
		if (!relativePath) return;
		if (!this.baselineReady) {
			this.pendingMutations.add(relativePath);
			return;
		}
		this.recordReadyMutation(relativePath);
	}

	private recordReadyMutation(relativePath: string): void {
		if (this.baseline.has(relativePath)) {
			this.protectedPaths.add(relativePath);
			return;
		}
		const ownedPath: OwnedPath = { path: relativePath, fingerprint: undefined };
		this.owned.set(relativePath, ownedPath);
		const fingerprintPromise = this.captureOwnedFingerprint(relativePath, ownedPath, this.generation);
		this.ownedFingerprintPromises.set(relativePath, fingerprintPromise);
		void fingerprintPromise.finally(() => {
			if (this.ownedFingerprintPromises.get(relativePath) === fingerprintPromise) {
				this.ownedFingerprintPromises.delete(relativePath);
			}
		});
	}

	async classify(files: AiraChangeFile[] | undefined): Promise<AiraWorkspaceOwnershipObservation> {
		await this.baselinePromise;
		await Promise.all(this.ownedFingerprintPromises.values());
		if (this.disposed) return this.observation();
		const bounded = (files ?? []).slice(0, MAX_TRACKED_PATHS);
		this.current = new Map(bounded.map((file) => [file.path, file]));
		this.protectedPaths = new Set([...this.protectedPaths]);
		this.unownedPaths.clear();
		for (const file of bounded) {
			if (this.baseline.has(file.path)) continue;
			const owned = this.owned.get(file.path);
			if (!owned) {
				this.unownedPaths.add(file.path);
				continue;
			}
			if (owned.fingerprint) {
				const now = await fingerprintFor(this.cwd, file);
				if (!sameFingerprint(owned.fingerprint, now)) {
					this.protectedPaths.add(file.path);
				}
			}
		}
		return this.observation();
	}

	observation(): AiraWorkspaceOwnershipObservation {
		const current = [...this.current.values()].slice(0, MAX_TRACKED_PATHS);
		const baseline = [...this.baseline.values()].slice(0, MAX_TRACKED_PATHS);
		const baselinePaths = new Set(this.baseline.keys());
		const owned = current.filter((file) => this.owned.has(file.path) && !this.protectedPaths.has(file.path));
		const protectedFiles = current.filter(
			(file) => baselinePaths.has(file.path) || this.protectedPaths.has(file.path),
		);
		const unowned = current.filter(
			(file) => !baselinePaths.has(file.path) && !this.owned.has(file.path) && this.unownedPaths.has(file.path),
		);
		return {
			available: this.baselineReady,
			baseline,
			owned,
			protected: protectedFiles,
			unowned,
			counts: {
				baseline: baseline.length,
				owned: owned.length,
				protected: protectedFiles.length,
				unowned: unowned.length,
			},
		};
	}

	async authorizeDestructivePath(path: string): Promise<AiraWorkspaceRepairDecision> {
		if (!this.activeGoal)
			return { allowed: true, path: this.toRelative(path), reason: "no active Goal repair scope" };
		if (!(await this.refreshForGuard()))
			return this.refused(this.toRelative(path), "workspace ownership is unavailable");
		return this.authorizeClassifiedPath(path);
	}

	async authorizeDestructiveCommand(command: string): Promise<AiraWorkspaceRepairDecision> {
		if (!isDestructiveCommand(command)) {
			return { allowed: true, reason: "command is not a recognized destructive workspace operation" };
		}
		const paths = destructiveCommandPaths(command);
		if (paths.length === 0) return this.refused(undefined, "destructive workspace operation has no bounded target");
		if (!this.activeGoal) return { allowed: true, reason: "no active Goal repair scope" };
		if (!(await this.refreshForGuard())) return this.refused(undefined, "workspace ownership is unavailable");
		for (const path of paths) {
			const decision = this.authorizeClassifiedPath(path);
			if (!decision.allowed) return decision;
		}
		return { allowed: true, reason: "all destructive targets are Goal-owned" };
	}

	private authorizeClassifiedPath(path: string): AiraWorkspaceRepairDecision {
		const relativePath = this.toRelative(path);
		if (!relativePath) return this.refused(path, "path is outside the Goal workspace");
		if (!this.baselineReady) return this.refused(relativePath, "workspace ownership is unavailable");
		if (this.baseline.has(relativePath)) return this.refused(relativePath, "protected pre-existing workspace change");
		const owned = this.owned.get(relativePath);
		if (!owned || !owned.fingerprint || this.protectedPaths.has(relativePath)) {
			return this.refused(relativePath, "protected unowned or ambiguous workspace change");
		}
		return { allowed: true, path: relativePath, reason: "Goal-owned workspace change" };
	}

	private async refreshForGuard(): Promise<boolean> {
		try {
			const files = await this.snapshot();
			if (files === undefined) return false;
			await this.classify(files);
			return this.baselineReady;
		} catch {
			return false;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.activeGoal = false;
		this.generation += 1;
		this.baseline.clear();
		this.owned.clear();
		this.current.clear();
		this.protectedPaths.clear();
		this.unownedPaths.clear();
		this.pendingMutations.clear();
	}

	private async captureBaseline(generation: number): Promise<void> {
		try {
			const files = await this.snapshot();
			if (this.disposed || generation !== this.generation) return;
			this.baseline = new Map((files ?? []).slice(0, MAX_TRACKED_PATHS).map((file) => [file.path, file]));
			for (const path of this.owned.keys()) {
				if (this.baseline.has(path)) this.protectedPaths.add(path);
			}
			this.baselineReady = files !== undefined;
			if (!this.baselineReady) {
				this.pendingMutations.clear();
				return;
			}
			const pendingMutations = [...this.pendingMutations];
			this.pendingMutations.clear();
			for (const path of pendingMutations) this.recordReadyMutation(path);
		} catch {
			this.baselineReady = false;
			this.pendingMutations.clear();
		}
	}

	private async captureOwnedFingerprint(path: string, expected: OwnedPath, generation: number): Promise<void> {
		if (this.disposed || generation !== this.generation || !this.baselineReady || this.baseline.has(path)) return;
		let current: AiraChangeFile[] | undefined;
		try {
			current = await this.snapshot();
		} catch {
			return;
		}
		const file = current?.find((candidate) => candidate.path === path);
		if (!file || this.owned.get(path) !== expected || generation !== this.generation) return;
		expected.fingerprint = await fingerprintFor(this.cwd, file);
		if (this.owned.get(path) !== expected || generation !== this.generation) expected.fingerprint = undefined;
	}

	private toRelative(path: string): string | undefined {
		const absolute = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
		const rel = relative(this.cwd, absolute).replace(/\\/g, "/");
		return rel.length > 0 && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
	}

	private refused(path: string | undefined, reason: string): AiraWorkspaceRepairDecision {
		return { allowed: false, ...(path ? { path } : {}), reason: bound(reason) };
	}
}

export function createAiraWorkspaceOwnershipManager(
	options: AiraWorkspaceOwnershipOptions,
): AiraWorkspaceOwnershipHandle {
	return new AiraWorkspaceOwnershipManager(options);
}

export function isDestructiveCommand(command: string): boolean {
	return /(?:^|[;&|]+\s*)(?:git\s+(?:restore|checkout|reset)|rm(?:\s|$))/i.test(command.trim());
}

function destructiveCommandPaths(command: string): string[] {
	const gitMatch = /git\s+(?:restore|checkout)\b([\s\S]*)/i.exec(command);
	if (gitMatch) {
		const tail = gitMatch[1].trim();
		const marker = tail.indexOf("--");
		if (marker < 0) return [];
		return shellWords(tail.slice(marker + 2));
	}
	const resetMatch = /git\s+reset\b([\s\S]*)/i.exec(command);
	if (resetMatch) {
		const tail = resetMatch[1].replace(/--(?:hard|mixed|soft)?/gi, " ");
		return shellWords(tail);
	}
	const rmMatch = /(?:^|[;&|]\s*)rm\b([\s\S]*)/i.exec(command);
	return rmMatch ? shellWords(rmMatch[1]).filter((word) => !word.startsWith("-")) : [];
}

function shellWords(text: string): string[] {
	return [...text.matchAll(/(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)]
		.map((match) => match[1] ?? match[2] ?? match[3] ?? "")
		.filter((word) => word.length > 0 && word !== "." && word !== "..")
		.slice(0, MAX_TRACKED_PATHS);
}

function toolPathFromArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const path = (args as Record<string, unknown>).path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

async function fingerprintFor(cwd: string, file: AiraChangeFile): Promise<Fingerprint> {
	let content = "missing";
	try {
		content = createHash("sha1")
			.update(await readFile(join(cwd, file.path)))
			.digest("hex");
	} catch {
		// Deleted paths remain fingerprintable through their change metadata.
	}
	return { change: `${file.status}\0${file.added}\0${file.deleted}`, content };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
	return left.change === right.change && left.content === right.content;
}

function bound(text: string): string {
	return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS - 1)}…`;
}
