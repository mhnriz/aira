/**
 * Aira browser — the runtime owner.
 *
 * One `AiraBrowserManager` per AgentSession; the single owner of Aira's
 * browser capability (ADR-005/ADR-025):
 *
 * - activation: availability probe + settings gate (browser.enabled);
 * - eligibility: evidence-based ambient eligibility (eligibility.ts);
 * - lifecycle: owns the browser session and every tab it created;
 * - provider boundary: drives a `AiraBrowserProvider`, never browser
 *   internals;
 * - Phase 6 association: reads the execution runtime's dev processes for
 *   local URL discovery (never duplicates process ownership);
 * - verification: ONE bounded auto-verify pass after a browser-relevant edit
 *   (settings + eligibility gated; no loops);
 * - ambient context: builds the bounded browser pack (context.ts), dedupes
 *   unchanged content, honors browser.context off|auto|on;
 * - canonical state: publishes the bounded `state.browser` snapshot (the
 *   future Workbench renders this without model tokens);
 * - cleanup: dispose kills ONLY Aira's own browser process.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { displayPathUnderHome, getAiraCacheDir } from "../paths.ts";
import type { AiraSessionState } from "../state.ts";
import { CDP_PROVIDER_ID } from "./cdp/launch.ts";
import { CdpBrowserProvider } from "./cdp/provider.ts";
import { buildBrowserContext } from "./context.ts";
import { decideBrowserEligibility, isBrowserRelevantPath } from "./eligibility.ts";
import type {
	AiraBrowserAvailability,
	AiraBrowserClickOptions,
	AiraBrowserNavigateOptions,
	AiraBrowserObserveOptions,
	AiraBrowserOpenOptions,
	AiraBrowserProvider,
} from "./provider.ts";
import type { AiraBrowserSettings } from "./settings.ts";
import {
	type AiraBrowserAvailabilityState,
	type AiraBrowserFinding,
	type AiraBrowserRuntimeStatus,
	type AiraBrowserStatus,
	type AiraBrowserTabSnapshot,
	initialAiraBrowserStatus,
} from "./status.ts";
import type {
	AiraBrowserEvidenceDrain,
	AiraBrowserObservation,
	AiraBrowserOperationResult,
	AiraBrowserSessionRecord,
	AiraBrowserTabRecord,
	AiraBrowserWaitCondition,
} from "./types.ts";
import { discoverLocalUrl, isSafeLocalUrl } from "./url-discovery.ts";

export const AIRA_BROWSER_CONTEXT_TYPE = "aira.browser";

/** The Phase 6 execution-runtime association (wired by the host). */
export interface AiraBrowserDevRuntime {
	running: boolean;
	/** Bounded concatenated dev-process output (URL discovery evidence). */
	output: string;
	/** Identifier of the associated managed dev process, when any. */
	processId?: string;
	/** Process status from the execution snapshot. */
	processStatus?: string;
}

/** The slice of the manager the model-facing tools bind to. */
export interface AiraBrowserHandle {
	activate(): Promise<void>;
	providePromptContext(prompt: string): string | undefined;
	open(options?: AiraBrowserManagerOpenOptions): Promise<AiraBrowserOperationResult>;
	observe(options?: AiraBrowserObserveOptions): Promise<AiraBrowserObservationResult>;
	navigate(options: AiraBrowserNavigateOptions): Promise<AiraBrowserOperationResult>;
	click(options: AiraBrowserClickOptions): Promise<AiraBrowserOperationResult>;
	fill(ref: string, value: string | boolean): Promise<AiraBrowserOperationResult>;
	pressKey(key: string, modifiers?: number): Promise<AiraBrowserOperationResult>;
	scroll(ref: string | undefined, deltaX: number, deltaY: number): Promise<AiraBrowserOperationResult>;
	wait(condition: AiraBrowserWaitCondition, timeoutMs: number): Promise<AiraBrowserOperationResult>;
	evaluate(expression: string, timeoutMs?: number): Promise<AiraBrowserOperationResult>;
	consoleEvidence(levels?: readonly string[], sinceSeq?: number, limit?: number): Promise<AiraBrowserEvidenceDrain>;
	networkEvidence(sinceSeq?: number, limit?: number): Promise<AiraBrowserEvidenceDrain>;
	screenshot(): Promise<{ ok: boolean; path?: string; reason?: string }>;
	verify(url?: string): Promise<AiraBrowserOperationResult>;
	close(tabId?: string): Promise<AiraBrowserOperationResult>;
	status(): AiraBrowserStatus;
	subscribe(listener: (status: AiraBrowserStatus) => void): () => void;
	applyAgentEvent(event: AgentEvent): void;
	dispose(): Promise<void>;
}

/** Observe result: bounded observation + fresh evidence summaries. */
export interface AiraBrowserObservationResult {
	observation: AiraBrowserObservation;
	console: AiraBrowserStatus["console"];
	network: AiraBrowserStatus["network"];
}

/** Open options without the manager-owned profileDir. */
export type AiraBrowserManagerOpenOptions = Omit<AiraBrowserOpenOptions, "profileDir">;

export interface AiraBrowserManagerOptions {
	/** Provider instance or factory (tests inject fakes). */
	provider?: AiraBrowserProvider | (() => AiraBrowserProvider);
	/** Settings accessor (canonical host settings). */
	settings?: () => AiraBrowserSettings;
	/** Phase 6 dev-runtime association. */
	devRuntime?: () => AiraBrowserDevRuntime;
	/** Agent for edit-event subscription (autoVerify/eligibility). */
	agent?: Agent;
	/** Base dir for Aira-owned browser profiles. */
	cacheDir?: string;
	/** Auto-verify debounce after a relevant edit (default 800ms). */
	autoVerifyDebounceMs?: number;
	/** Min gap between automatic verification passes (default 2s). */
	minVerifyGapMs?: number;
	/** Max retained screenshots (default 8; older deleted). */
	maxScreenshots?: number;
	/** Injectable clock (tests). */
	now?: () => number;
	/** Injectable browser-relevance predicate (tests). */
	isRelevantPath?: (path: string) => boolean;
}

const DEFAULT_AUTO_VERIFY_DEBOUNCE_MS = 800;
const DEFAULT_MIN_VERIFY_GAP_MS = 2_000;
const DEFAULT_MAX_SCREENSHOTS = 8;
const VERIFY_SETTLE_MS = 300;
const DEFAULT_BROWSER_SETTINGS: AiraBrowserSettings = {
	enabled: true,
	context: "auto",
	autoVerify: true,
	contextBudget: "compact",
};

export class AiraBrowserManager implements AiraBrowserHandle {
	private readonly state: AiraSessionState;
	private readonly options: AiraBrowserManagerOptions & {
		autoVerifyDebounceMs: number;
		minVerifyGapMs: number;
		maxScreenshots: number;
	};
	private provider: AiraBrowserProvider | undefined;
	private readonly session: AiraBrowserSessionRecord = {
		id: "browser-1",
		ownerSessionId: "pending",
		providerId: CDP_PROVIDER_ID,
		profileDir: "",
		status: "closed",
		tabs: [],
		createdAt: 0,
		lastActivityAt: 0,
	};
	private availability: AiraBrowserAvailability = {
		available: false,
		provider: CDP_PROVIDER_ID,
		reason: "not probed",
	};
	private availabilityProbed = false;
	private statusSnapshot: AiraBrowserStatus = initialAiraBrowserStatus();
	private degradedReason: string | undefined;
	private readonly listeners = new Set<(status: AiraBrowserStatus) => void>();
	private lastContextHash: string | undefined;
	private lastInjectedAt = 0;
	/** Active-tab URL at the last injection (tab-change signal cursor). */
	private lastInjectedTabUrl: string | undefined;
	private lastVerificationSignalAt = 0;
	private pendingBrowserEdits = 0;
	private lastEditPath: string | undefined;
	private pendingEditPath: string | undefined;
	private verifyTimer: NodeJS.Timeout | undefined;
	private lastVerifyAt = 0;
	private disposed = false;
	private readonly now: () => number;
	/** Cached evidence summaries (refreshed after every operation). */
	private consoleEvidenceCache: AiraBrowserStatus["console"] = { errors: 0, warnings: 0, total: 0 };
	private networkEvidenceCache: AiraBrowserStatus["network"] = { failures: 0 };
	private observationRevision = 0;
	private observationSummary: string | undefined;
	private observationNodeCount: number | undefined;
	private observationAt = 0;

	constructor(state: AiraSessionState, options: AiraBrowserManagerOptions = {}) {
		this.state = state;
		this.options = {
			...options,
			autoVerifyDebounceMs: options.autoVerifyDebounceMs ?? DEFAULT_AUTO_VERIFY_DEBOUNCE_MS,
			minVerifyGapMs: options.minVerifyGapMs ?? DEFAULT_MIN_VERIFY_GAP_MS,
			maxScreenshots: options.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS,
		};
		this.now = options.now ?? (() => Date.now());
		this.session.ownerSessionId = state.sessionId;
		this.session.profileDir = this.resolveProfileDir();
		this.options.agent?.subscribe((event) => this.applyAgentEvent(event));
		this.publish();
	}

	// =========================================================================
	// Activation / availability
	// =========================================================================

	async activate(): Promise<void> {
		if (this.disposed) return;
		try {
			const availability = await this.providerInstance().probeAvailability();
			this.availability = availability;
		} catch {
			this.availability = { available: false, provider: CDP_PROVIDER_ID, reason: "provider probe failed" };
		}
		this.availabilityProbed = true;
		this.publish();
	}

	private providerInstance(): AiraBrowserProvider {
		if (!this.provider) {
			const candidate = this.options.provider;
			this.provider = typeof candidate === "function" ? candidate() : (candidate ?? this.defaultProvider());
			this.provider.onBrowserExit((reason) => {
				this.degradedReason = reason;
				this.session.status = "degraded";
				this.session.tabs = [];
				this.publish();
			});
		}
		return this.provider;
	}

	private defaultProvider(): AiraBrowserProvider {
		return new CdpBrowserProvider({ profileDir: this.session.profileDir });
	}

	private resolveProfileDir(): string {
		const base = this.options.cacheDir ?? join(getAiraCacheDir(), "browser");
		const safeId = this.state.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
		return join(base, `session-${safeId || "anon"}`);
	}

	// =========================================================================
	// Operations (tool-facing)
	// =========================================================================

	async open(options: AiraBrowserManagerOpenOptions = {}): Promise<AiraBrowserOperationResult> {
		if (this.disposed) return fail("open", "browser runtime is disposed");
		if (!this.settingsOf().enabled) return fail("open", "browser is disabled (browser.enabled=false)");
		const availability = this.availabilityProbed ? this.availability : await this.probeNow();
		if (!availability.available) {
			return fail("open", `browser unavailable: ${availability.reason ?? "no usable browser"}`);
		}
		const provider = this.providerInstance();
		const resolved = await provider.open({
			profileDir: this.session.profileDir,
			url: options.url,
			extraAllowedOrigins: options.extraAllowedOrigins,
			timeoutMs: options.timeoutMs,
			reuseProfile: options.reuseProfile,
		});
		if (resolved.ok) {
			this.session.status = "running";
			this.session.createdAt = this.now();
			this.degradedReason = undefined;
		} else {
			this.session.status = "degraded";
			this.degradedReason = resolved.reason;
		}
		await this.settle();
		return resolved;
	}

	async observe(options: AiraBrowserObserveOptions = {}): Promise<AiraBrowserObservationResult> {
		const tab = this.requireActiveTab("observe");
		const provider = this.requireProvider();
		const observation = await provider.observe(tab, options);
		this.recordObservation(tab, observation);
		await this.settle();
		return { observation, console: this.consoleEvidenceCache, network: this.networkEvidenceCache };
	}

	async navigate(options: AiraBrowserNavigateOptions): Promise<AiraBrowserOperationResult> {
		const tab = this.requireActiveTab("navigate");
		const provider = this.requireProvider();
		const result = await provider.navigate(tab, options);
		await this.settle();
		return result;
	}

	async click(options: AiraBrowserClickOptions): Promise<AiraBrowserOperationResult> {
		const tab = this.requireActiveTab("click");
		const provider = this.requireProvider();
		const result = await provider.click(tab, options);
		await this.settle();
		return result;
	}

	async fill(ref: string, value: string | boolean): Promise<AiraBrowserOperationResult> {
		const tab = this.requireActiveTab("fill");
		const provider = this.requireProvider();
		const result = await provider.fill(tab, ref, value);
		await this.settle();
		return result;
	}

	async pressKey(key: string, modifiers = 0): Promise<AiraBrowserOperationResult> {
		const tab = this.requireActiveTab("press");
		const provider = this.requireProvider();
		const result = await provider.pressKey(tab, key, modifiers);
		await this.settle();
		return result;
	}

	async scroll(ref: string | undefined, deltaX: number, deltaY: number): Promise<AiraBrowserOperationResult> {
		const tab = this.requireActiveTab("scroll");
		const provider = this.requireProvider();
		const result = await provider.scroll(tab, ref, deltaX, deltaY);
		this.touch();
		return result;
	}

	async wait(condition: AiraBrowserWaitCondition, timeoutMs: number): Promise<AiraBrowserOperationResult> {
		const tab = this.requireActiveTab("wait");
		const provider = this.requireProvider();
		const result = await provider.wait(tab, condition, timeoutMs);
		this.touch();
		await this.settle();
		return result;
	}

	async evaluate(expression: string, timeoutMs = 10_000): Promise<AiraBrowserOperationResult> {
		const tab = this.requireActiveTab("evaluate");
		const provider = this.requireProvider();
		const result = await provider.evaluate(tab, { expression, timeoutMs });
		this.touch();
		return result;
	}

	async consoleEvidence(
		levels?: readonly string[],
		sinceSeq?: number,
		limit = 100,
	): Promise<AiraBrowserEvidenceDrain> {
		const tab = this.activeTabOptional();
		if (!tab) return { total: 0, overflowed: false, records: [] };
		return this.requireProvider().consoleEvidence(tab, { levels: [...(levels ?? [])] as never, sinceSeq, limit });
	}

	async networkEvidence(sinceSeq?: number, limit = 100): Promise<AiraBrowserEvidenceDrain> {
		const tab = this.activeTabOptional();
		if (!tab) return { total: 0, overflowed: false, records: [] };
		return this.requireProvider().networkEvidence(tab, { sinceSeq, limit });
	}

	async screenshot(): Promise<{ ok: boolean; path?: string; reason?: string }> {
		const tab = this.requireActiveTab("screenshot");
		const provider = this.requireProvider();
		try {
			const dir = join(this.options.cacheDir ?? join(getAiraCacheDir(), "browser"), "screenshots");
			const path = await provider.screenshot(tab, dir, "aira");
			this.pruneScreenshots(dir);
			this.statusSnapshot.screenshot = { lastPath: path, lastAt: this.now() };
			this.publish();
			return { ok: true, path };
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	/** One bounded verification pass (explicit or automatic). */
	async verify(url?: string): Promise<AiraBrowserOperationResult> {
		const started = this.now();
		if (this.disposed) return fail("verify", "browser runtime is disposed");
		if (!this.settingsOf().enabled) return fail("verify", "browser is disabled (browser.enabled=false)");

		const dev = this.devRuntime();
		const target = url ?? this.devUrl(dev);
		if (!target || !isSafeLocalUrl(target)) {
			this.statusSnapshot.verification = { status: "none", lastCheckAt: started };
			this.publish();
			return fail(
				"verify",
				target ? `unsafe verification target: ${target}` : "no local URL available (start a dev process first)",
			);
		}
		if (!dev.running) {
			this.statusSnapshot.verification = { status: "none", lastCheckAt: started };
			this.publish();
			return fail("verify", "the associated dev process is not running");
		}

		const opened = await this.open();
		if (!opened.ok) {
			this.statusSnapshot.verification = {
				status: "failed",
				lastCheckAt: this.now(),
				finding: { message: opened.reason ?? "browser open failed", count: 1, firstAt: started, lastAt: started },
			};
			this.publish();
			return opened;
		}
		const tab = this.requireActiveTab("verify");
		const provider = this.requireProvider();
		const currentTab = provider.tabs().find((t) => t.id === tab);
		if (currentTab && currentTab.url !== target) {
			const navigate = await provider.navigate(tab, {
				url: target,
				waitUntil: "domcontentloaded",
				timeoutMs: 30_000,
			});
			if (!navigate.ok) {
				this.statusSnapshot.verification = {
					status: "failed",
					lastCheckAt: this.now(),
					finding: {
						message: `navigation failed: ${navigate.reason ?? "unknown"}`,
						count: 1,
						firstAt: started,
						lastAt: started,
					},
				};
				this.publish();
				return navigate;
			}
		}
		await sleep(VERIFY_SETTLE_MS);
		let observation: AiraBrowserObservation;
		try {
			observation = await provider.observe(tab, { maxNodes: 250, maxChars: 2500 });
		} catch (err) {
			this.statusSnapshot.verification = {
				status: "failed",
				lastCheckAt: this.now(),
				finding: {
					message: `observation failed: ${err instanceof Error ? err.message : String(err)}`,
					count: 1,
					firstAt: started,
					lastAt: started,
				},
			};
			this.publish();
			return fail("verify", `observation failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.recordObservation(tab, observation);
		await this.refreshEvidence();
		const top = this.consoleEvidenceCache.topFinding ?? this.networkEvidenceCache.topFinding;
		const passed = this.consoleEvidenceCache.errors === 0 && this.networkEvidenceCache.failures === 0;
		this.statusSnapshot.verification = {
			status: passed ? "passed" : "failed",
			lastCheckAt: this.now(),
			finding: top ? toFinding(top, this.now()) : undefined,
		};
		this.lastVerifyAt = this.now();
		this.lastVerificationSignalAt = this.lastVerifyAt;
		this.touch();
		this.publish();
		return {
			ok: true,
			operation: "verify",
			target,
			tab: this.tabSnapshot(),
			console: { ...this.consoleEvidenceCache },
			network: { ...this.networkEvidenceCache },
		};
	}

	async close(tabId?: string): Promise<AiraBrowserOperationResult> {
		if (this.disposed) return fail("close", "browser runtime is disposed");
		const provider = this.providerInstance();
		if (tabId) {
			const result = await provider.closeTab(tabId);
			await this.settle();
			return result;
		}
		await provider.close();
		this.session.status = "closed";
		this.session.tabs = [];
		this.session.createdAt = 0;
		this.degradedReason = undefined;
		this.consoleEvidenceCache = { errors: 0, warnings: 0, total: 0 };
		this.networkEvidenceCache = { failures: 0 };
		this.touch();
		this.publish();
		return { ok: true, operation: "close" };
	}

	status(): AiraBrowserStatus {
		return this.statusSnapshot;
	}

	subscribe(listener: (status: AiraBrowserStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// =========================================================================
	// Ambient context
	// =========================================================================

	providePromptContext(_prompt: string): string | undefined {
		if (this.disposed || this.state.runtime !== "active") return undefined;
		const settings = this.settingsOf();

		// Tab-change signal: the active page URL differs from the last injected
		// one (open/navigate move it; steady state never re-triggers).
		const activeUrl = this.statusSnapshot.activeTab?.url;
		const tabChanged = activeUrl !== undefined && activeUrl !== this.lastInjectedTabUrl;
		const verificationChanged = this.lastVerificationSignalAt > this.lastInjectedAt;
		const relevanceSignal = tabChanged || verificationChanged || this.pendingBrowserEdits > 0;

		const built = buildBrowserContext({
			settings: { context: settings.context, budget: settings.contextBudget },
			status: this.statusSnapshot,
			relevanceSignal,
			pendingEdits: this.pendingBrowserEdits,
			lastHash: this.lastContextHash,
		});
		if (!built.content || built.hash === undefined) return undefined;
		this.lastContextHash = built.hash;
		this.lastInjectedAt = this.now();
		this.lastInjectedTabUrl = this.statusSnapshot.activeTab?.url;
		this.pendingBrowserEdits = 0;
		return built.content;
	}

	// =========================================================================
	// Agent events / autoVerify
	// =========================================================================

	applyAgentEvent(event: AgentEvent): void {
		if (this.disposed) return;
		if (event.type === "tool_execution_start" && (event.toolName === "edit" || event.toolName === "write")) {
			const path = agentToolPath(event.args);
			if (path) this.pendingEditPath = path;
			return;
		}
		if (event.type === "tool_execution_end" && (event.toolName === "edit" || event.toolName === "write")) {
			const path = this.pendingEditPath;
			this.pendingEditPath = undefined;
			if (!path || event.isError) return;
			const relevant = (this.options.isRelevantPath ?? isBrowserRelevantPath)(path);
			if (!relevant) return;
			this.lastEditPath = path;
			this.pendingBrowserEdits += 1;
			this.publish();
			if (this.settingsOf().autoVerify && this.state.mode === "build") {
				this.scheduleAutoVerify();
			}
		}
	}

	private scheduleAutoVerify(): void {
		const existing = this.verifyTimer;
		if (existing) clearTimeout(existing);
		this.verifyTimer = setTimeout(() => {
			this.verifyTimer = undefined;
			void this.runAutoVerify();
		}, this.options.autoVerifyDebounceMs);
	}

	/** The single bounded automatic verification pass (no retry loops). */
	private async runAutoVerify(): Promise<void> {
		if (this.disposed || this.state.mode !== "build") return;
		const settings = this.settingsOf();
		if (!settings.enabled || !settings.autoVerify) return;
		if (this.now() - this.lastVerifyAt < this.options.minVerifyGapMs) return;
		const dev = this.devRuntime();
		if (!dev.running) return;
		const url = this.devUrl(dev);
		if (!url) return;
		const eligibility = this.eligibility(dev);
		if (!eligibility.eligible || !eligibility.changeRelevant) return;
		await this.verify(url);
	}

	// =========================================================================
	// Dev runtime association / eligibility
	// =========================================================================

	private devRuntime(): AiraBrowserDevRuntime {
		const accessor = this.options.devRuntime;
		if (!accessor) return { running: false, output: "" };
		try {
			return accessor();
		} catch {
			return { running: false, output: "" };
		}
	}

	private devUrl(dev: AiraBrowserDevRuntime): string | undefined {
		if (!dev.running || !dev.output) return undefined;
		const evidence = discoverLocalUrl(dev.output, this.state.project);
		return evidence.url;
	}

	private eligibility(dev?: AiraBrowserDevRuntime): { eligible: boolean; changeRelevant: boolean } {
		const runtime = dev ?? this.devRuntime();
		return decideBrowserEligibility({
			project: this.state.project,
			mode: this.state.mode,
			devRunning: runtime.running,
			localUrl: this.devUrl(runtime),
			lastEditPath: this.lastEditPath,
		});
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.verifyTimer) {
			clearTimeout(this.verifyTimer);
			this.verifyTimer = undefined;
		}
		try {
			await this.provider?.dispose();
		} catch {
			// Best-effort teardown; the host's detached-child tracking is the
			// last-resort reaper for a wedged browser process.
		}
		this.session.status = "closed";
		this.session.tabs = [];
		this.listeners.clear();
		this.publish();
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private async settle(): Promise<void> {
		this.touch();
		await this.refreshEvidence();
		this.refreshTabMirror();
		this.publish();
	}

	/** Refresh cached evidence summaries from the active tab (async). */
	private async refreshEvidence(): Promise<void> {
		const tab = this.activeTabOptional();
		if (!tab) {
			this.consoleEvidenceCache = { errors: 0, warnings: 0, total: 0 };
			this.networkEvidenceCache = { failures: 0 };
			return;
		}
		try {
			const provider = this.requireProvider();
			const consoleDrain = await provider.consoleEvidence(tab, { limit: 1 });
			this.consoleEvidenceCache = {
				errors: consoleDrain.errors ?? 0,
				warnings: consoleDrain.warnings ?? 0,
				total: consoleDrain.total,
				topFinding: consoleDrain.topFinding ? toFinding(consoleDrain.topFinding, this.now()) : undefined,
			};
			const networkDrain = await provider.networkEvidence(tab, { limit: 1 });
			this.networkEvidenceCache = {
				failures: networkDrain.failures ?? 0,
				topFinding: networkDrain.topFinding ? toFinding(networkDrain.topFinding, this.now()) : undefined,
			};
		} catch {
			// Evidence refresh must never break an operation result.
		}
	}

	/** Mirror provider tabs into the session record (bounded table). */
	private refreshTabMirror(): void {
		try {
			const providerTabs = this.provider?.tabs() ?? [];
			const byId = new Map(this.session.tabs.map((t) => [t.id, t]));
			this.session.tabs = providerTabs.map((t) => {
				const prior = byId.get(t.id);
				return {
					id: t.id,
					targetId: prior?.targetId ?? t.id,
					url: t.url,
					title: t.title,
					readyState: t.readyState as AiraBrowserTabRecord["readyState"],
					observationRevision: prior?.observationRevision ?? 0,
					observationSummary: prior?.observationSummary,
					lastActivityAt: this.now(),
				};
			});
		} catch {
			// Tab mirror is best-effort (provider may be mid-teardown).
		}
	}

	private recordObservation(_tabId: string, observation: AiraBrowserObservation): void {
		this.observationRevision += 1;
		this.observationSummary = observation.summary;
		this.observationNodeCount = observation.nodeCount;
		this.observationAt = observation.at;
		this.refreshTabMirror();
	}

	private publish(): void {
		const dev = this.devRuntime();
		const eligibility = this.eligibility(dev);
		const tabs = this.sessionTabs();
		const active = this.activeTabSnapshot(tabs);

		this.statusSnapshot = {
			availability: this.availabilityForStatus(),
			eligible: eligibility.eligible,
			status: this.runtimeStatus(),
			provider: CDP_PROVIDER_ID,
			profileKind: "isolated",
			profileDir: displayPathUnderHome(this.session.profileDir),
			tabs,
			activeTab: active,
			console: { ...this.consoleEvidenceCache },
			network: { ...this.networkEvidenceCache },
			observation: {
				revision: this.observationRevision,
				summary: this.observationSummary,
				nodeCount: this.observationNodeCount,
				lastAt: this.observationAt === 0 ? undefined : this.observationAt,
			},
			verification: { ...this.statusSnapshot.verification },
			screenshot: this.statusSnapshot.screenshot ? { ...this.statusSnapshot.screenshot } : {},
			devProcess: dev.running
				? { id: dev.processId ?? "dev", status: dev.processStatus ?? "running", url: this.devUrl(dev) }
				: undefined,
			reason:
				this.degradedReason ??
				(this.availabilityProbed && !this.availability.available ? this.availability.reason : undefined),
			updatedAt: this.now(),
		};
		if (this.state.runtime !== "disposed") {
			this.state.browser = this.statusSnapshot;
		}
		for (const listener of this.listeners) {
			try {
				listener(this.statusSnapshot);
			} catch {
				// A listener must never break the runtime.
			}
		}
	}

	private availabilityForStatus(): AiraBrowserAvailabilityState {
		const settings = this.settingsOf();
		if (!settings.enabled) return "disabled";
		if (!this.availabilityProbed) return "unknown";
		return this.availability.available ? "available" : "unavailable";
	}

	private runtimeStatus(): AiraBrowserRuntimeStatus {
		const settings = this.settingsOf();
		if (!settings.enabled) return "unavailable";
		if (this.session.status === "running") return "active";
		if (this.session.status === "degraded") return "degraded";
		if (this.availabilityProbed && !this.availability.available) return "unavailable";
		return "idle";
	}

	private sessionTabs(): AiraBrowserTabSnapshot[] {
		if (this.session.status !== "running") return [];
		return this.session.tabs.map((t) => ({
			id: t.id,
			url: t.url,
			title: t.title,
			readyState: t.readyState,
		}));
	}

	private activeTabSnapshot(tabs: AiraBrowserTabSnapshot[]): AiraBrowserTabSnapshot | undefined {
		if (tabs.length === 0) return undefined;
		const activeId = this.provider?.activeTabId();
		return tabs.find((t) => t.id === activeId) ?? tabs[0];
	}

	private tabSnapshot(): { id: string; url: string; title: string; readyState: string } | undefined {
		const active = this.activeTabSnapshot(this.sessionTabs());
		return active;
	}

	private requireActiveTab(operation: string): string {
		const tab = this.activeTabOptional();
		if (!tab) {
			throw new AiraBrowserNotOpenError(operation);
		}
		return tab;
	}

	private activeTabOptional(): string | undefined {
		if (this.session.status !== "running") return undefined;
		try {
			return this.provider?.activeTabId() ?? this.provider?.tabs()[0]?.id;
		} catch {
			return undefined;
		}
	}

	private requireProvider(): AiraBrowserProvider {
		if (!this.provider) {
			throw new Error("browser runtime is not open");
		}
		return this.provider;
	}

	private settingsOf(): AiraBrowserSettings {
		const accessor = this.options.settings;
		if (!accessor) return { ...DEFAULT_BROWSER_SETTINGS };
		try {
			return accessor();
		} catch {
			return { ...DEFAULT_BROWSER_SETTINGS };
		}
	}

	private async probeNow(): Promise<AiraBrowserAvailability> {
		try {
			const availability = await this.providerInstance().probeAvailability();
			this.availability = availability;
		} catch {
			this.availability = { available: false, provider: CDP_PROVIDER_ID, reason: "provider probe failed" };
		}
		this.availabilityProbed = true;
		return this.availability;
	}

	private touch(): void {
		this.session.lastActivityAt = this.now();
	}

	private pruneScreenshots(dir: string): void {
		try {
			const files = readdirSync(dir)
				.map((name) => {
					const path = join(dir, name);
					try {
						return { path, at: statSync(path).mtimeMs };
					} catch {
						return undefined;
					}
				})
				.filter((f): f is { path: string; at: number } => Boolean(f?.path.endsWith(".jpg")))
				.sort((a, b) => b.at - a.at);
			for (const file of files.slice(this.options.maxScreenshots)) {
				try {
					rmSync(file.path, { force: true });
				} catch {
					// best effort
				}
			}
		} catch {
			// screenshots directory may not exist yet
		}
	}
}

/** Truthful typed error for operations that need an open browser. */
export class AiraBrowserNotOpenError extends Error {
	readonly operation: string;
	constructor(operation: string) {
		super(`browser is not open (${operation}); call browser_open first`);
		this.name = "AiraBrowserNotOpenError";
		this.operation = operation;
	}
}

function fail(operation: string, reason: string): AiraBrowserOperationResult {
	return { ok: false, operation, reason };
}

function toFinding(
	like: { message: string; source?: string; line?: number; count: number },
	at: number,
): AiraBrowserFinding {
	return { message: like.message, source: like.source, line: like.line, count: like.count, firstAt: at, lastAt: at };
}

function agentToolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const path = record.path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create the session's browser manager (host seam). */
export function createAiraBrowserManager(
	state: AiraSessionState,
	options: AiraBrowserManagerOptions = {},
): AiraBrowserManager {
	return new AiraBrowserManager(state, options);
}
