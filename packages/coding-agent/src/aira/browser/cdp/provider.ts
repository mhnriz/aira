/**
 * Aira browser — native CDP/Chromium provider.
 *
 * The Phase 7 provider implementation behind the `AiraBrowserProvider`
 * boundary: launches an ISOLATED Aira-owned Chrome/Chromium (headless by
 * default, fresh profile from canonical Aira cache paths), connects a
 * zero-dependency CDP client, owns tabs it created (and popups opened from
 * them), captures bounded console/network evidence per tab, observes the
 * accessibility tree with stable refs, drives interaction primitives, and
 * cleans up its own browser process on dispose.
 *
 * This implementation is Aira-native: the CDP-wire approach follows the
 * patterns proven by the pi-browser-harness reference (AX-tree refs,
 * compositor input, DevToolsActivePort), but no reference source is copied
 * and Aira never attaches to a personal browser.
 */
import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trackDetachedChildPid, untrackDetachedChildPid } from "../../../utils/shell.ts";
import {
	type AiraBrowserAvailability,
	type AiraBrowserClickOptions,
	type AiraBrowserEvidenceFilter,
	type AiraBrowserNavigateOptions,
	type AiraBrowserObserveOptions,
	type AiraBrowserOpenOptions,
	type AiraBrowserProvider,
	elementTargetLabel,
} from "../provider.ts";
import type {
	AiraBrowserEvidenceDrain,
	AiraBrowserObservation,
	AiraBrowserOperationResult,
	AiraBrowserTarget,
	AiraBrowserWaitCondition,
} from "../types.ts";
import { CdpClient, failResult, okResult } from "./client.ts";
import { boxCenterOf, dispatchClick, dispatchKey, fillByRef, readLiveValue, resolveRefToBox } from "./interact.ts";
import {
	CDP_PROVIDER_ID,
	launchIsolatedBrowser,
	resolveChromiumExecutable,
	terminateBrowserProcess,
} from "./launch.ts";
import {
	assignRefs,
	buildSlimAxTree,
	collectInteractiveTargets,
	countAxNodes,
	renderOutline,
	type SlimAxNode,
	summarizeAxTree,
} from "./observe.ts";
import { CdpTabSession } from "./session.ts";

const OBSERVE_MAX_NODES = 400;
const OBSERVE_MAX_CHARS = 4000;
const NAVIGATE_TIMEOUT_MS = 30_000;
const WAIT_POLL_MS = 100;
const BOX_BUDGET_PER_OBSERVE = 60;

interface ProviderTab {
	record: { id: string; url: string; title: string; readyState: string };
	cdp: CdpTabSession;
}

export interface CdpBrowserProviderOptions {
	profileDir: string;
	headed?: boolean;
	/** Injectable launch for tests. */
	launch?: typeof launchIsolatedBrowser;
	/** Injectable executable resolution for tests. */
	resolve?: typeof resolveChromiumExecutable;
	/** Injectable kill for tests. */
	terminate?: typeof terminateBrowserProcess;
	now?: () => number;
}

export class CdpBrowserProvider implements AiraBrowserProvider {
	readonly id = CDP_PROVIDER_ID;
	private readonly options: CdpBrowserProviderOptions;
	private client: CdpClient | undefined;
	private child: ChildProcess | undefined;
	private readonly tabsById = new Map<string, ProviderTab>();
	private activeTabIdValue: string | undefined;
	private readonly exitListeners = new Set<(reason: string) => void>();
	private disposed = false;
	private closedReason: string | undefined;
	private tabCounter = 0;
	private readonly now: () => number;

	constructor(options: CdpBrowserProviderOptions) {
		this.options = options;
		this.now = options.now ?? (() => Date.now());
	}

	async probeAvailability(): Promise<AiraBrowserAvailability> {
		if (this.disposed) {
			return { available: false, provider: this.id, reason: "provider disposed" };
		}
		const resolve = this.options.resolve ?? resolveChromiumExecutable;
		const resolved = resolve();
		if (!resolved.ok) {
			return { available: false, provider: this.id, reason: resolved.reason };
		}
		return { available: true, provider: this.id, detail: resolved.executable.detail };
	}

	async open(options: AiraBrowserOpenOptions): Promise<AiraBrowserOperationResult> {
		if (this.disposed) {
			return failResult("open", "provider disposed");
		}
		if (this.client && this.child && this.child.exitCode === null) {
			const existing = this.activeTabOf();
			return okResult("open", existing ? { tab: existing } : undefined);
		}
		const resolve = this.options.resolve ?? resolveChromiumExecutable;
		const resolved = resolve();
		if (!resolved.ok) {
			return failResult("open", `browser unavailable: ${resolved.reason}`);
		}
		// The profile is disposable and Aira-owned: a fresh launch starts from a
		// clean directory. A stale DevToolsActivePort (from a killed browser,
		// a singleton-refused relaunch, or a Chrome version change) must never
		// misdirect the connect, and leftover profile junk must not accumulate.
		if (!options.reuseProfile) {
			try {
				rmSync(options.profileDir, { recursive: true, force: true });
			} catch {
				// best effort; the launch itself reports real failures
			}
		}
		const launch = this.options.launch ?? launchIsolatedBrowser;
		const launched = await launch({
			executable: resolved.executable.path,
			profileDir: options.profileDir,
			headed: this.options.headed,
		});
		if ("error" in launched) {
			return failResult("open", launched.error);
		}
		this.child = launched.child;
		// Crash-path orphan protection: the host's shutdown teardown reaps
		// tracked detached children (SIGHUP/SIGTERM, crash exit). Tracking is
		// removed when Aira closes the browser itself.
		if (launched.child.pid !== undefined) {
			trackDetachedChildPid(launched.child.pid);
		}
		this.client = new CdpClient({
			url: launched.handle.wsUrl,
			onEvent: (event) => this.onEvent(event),
			onClose: (reason) => this.onConnectionClosed(reason),
		});
		try {
			await this.client.connect();
		} catch (err) {
			await launched.handle.kill(0);
			this.child = undefined;
			this.client = undefined;
			return failResult("open", `CDP connection failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		// A browser crash is truthfully reported as a degraded session.
		this.child.on("exit", (code, signal) => this.onBrowserExited(code, signal));

		await this.client.send("Target.setDiscoverTargets", { discover: true });
		await this.client.send("Page.enable");

		const created = await this.client.send("Target.createTarget", { url: "about:blank" });
		if (!created.ok) {
			await this.dispose();
			return failResult("open", `failed to create the initial tab: ${created.error}`);
		}
		const targetId = (created.data as { targetId?: string }).targetId;
		if (!targetId) {
			await this.dispose();
			return failResult("open", "failed to create the initial tab (no target id)");
		}
		await this.attachTab(targetId);
		if (options.url) {
			const navigate = await this.navigate(this.activeTabIdValue ?? this.firstTabId() ?? "", {
				url: options.url,
				waitUntil: "domcontentloaded",
				timeoutMs: options.timeoutMs ?? NAVIGATE_TIMEOUT_MS,
			});
			if (!navigate.ok && !navigate.reason?.includes("did not reach")) {
				return navigate;
			}
		}
		return okResult("open");
	}

	async close(): Promise<AiraBrowserOperationResult> {
		return this.disposeSession();
	}

	tabs(): Array<{ id: string; url: string; title: string; readyState: string }> {
		return [...this.tabsById.values()].map((t) => ({ ...t.record }));
	}

	activeTabId(): string | undefined {
		return this.activeTabIdValue;
	}

	async activateTab(tabId: string): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("activate-tab", `unknown tab ${tabId}`);
		await this.client?.send("Target.activateTarget", { targetId: tab.cdp.targetId });
		this.activeTabIdValue = tabId;
		return okResult("activate-tab", { tab: this.tabResult(tab) });
	}

	async closeTab(tabId: string): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("close-tab", `unknown tab ${tabId}`);
		await this.client?.send("Target.closeTarget", { targetId: tab.cdp.targetId });
		this.tabsById.delete(tabId);
		if (this.activeTabIdValue === tabId) {
			this.activeTabIdValue = [...this.tabsById.keys()][0];
		}
		return okResult("close-tab");
	}

	async observe(tabId: string, options: AiraBrowserObserveOptions = {}): Promise<AiraBrowserObservation> {
		const tab = this.requireTab(tabId, "observe");
		const client = this.requireClient();
		const maxNodes = options.maxNodes ?? OBSERVE_MAX_NODES;
		const maxChars = options.maxChars ?? OBSERVE_MAX_CHARS;

		const ax = await client.send("Accessibility.getFullAXTree", {}, tab.cdp.sessionId);
		const rawNodes = ax.ok ? ((ax.data as { nodes?: unknown[] }).nodes ?? []) : [];
		const slim = buildSlimAxTree(rawNodes as never, maxNodes);

		const pageInfo = await this.pageInfo(tab);
		tab.record = { ...tab.record, url: pageInfo.url, title: pageInfo.title, readyState: pageInfo.readyState };

		const targets = await this.targetsWithBoxes(slim, tab, pageInfo.url);
		const rendered = renderOutline(slim, maxChars);
		return {
			title: pageInfo.title,
			url: pageInfo.url,
			readyState: pageInfo.readyState,
			summary: summarizeAxTree(slim, { title: pageInfo.title, readyState: pageInfo.readyState }),
			nodeCount: countAxNodes(slim),
			outline: rendered.text,
			truncated: rendered.truncated,
			targets,
			at: this.now(),
		};
	}

	async navigate(tabId: string, options: AiraBrowserNavigateOptions): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("navigate", `unknown tab ${tabId}`);
		const client = this.requireClient();
		const timeoutMs = options.timeoutMs ?? NAVIGATE_TIMEOUT_MS;
		const deadline = this.now() + timeoutMs;

		const navigate = await client.send("Page.navigate", { url: options.url }, tab.cdp.sessionId);
		if (!navigate.ok) return failResult("navigate", `navigation failed: ${navigate.error}`, { target: options.url });

		const waitUntil = options.waitUntil ?? "domcontentloaded";
		let lastState = await this.pageInfo(tab);
		while (this.now() < deadline) {
			lastState = await this.pageInfo(tab);
			const ready = lastState.readyState;
			const reached =
				waitUntil === "commit"
					? lastState.url.startsWith(options.url)
					: waitUntil === "load"
						? ready === "complete"
						: ready === "interactive" || ready === "complete";
			if (reached) {
				tab.record = { ...tab.record, url: lastState.url, title: lastState.title, readyState: ready };
				return this.resultWithEvidence(
					okResult("navigate", { target: options.url, tab: this.tabResult(tab) }),
					tab,
				);
			}
			const dialog = tab.cdp.takeDialog();
			if (dialog) {
				return failResult("navigate", `page opened a ${dialog.type} dialog: ${dialog.message}`, {
					target: options.url,
				});
			}
			await sleep(WAIT_POLL_MS);
		}
		tab.record = { ...tab.record, url: lastState.url, title: lastState.title, readyState: lastState.readyState };
		return failResult("navigate", `navigation to ${options.url} did not reach "${waitUntil}" within ${timeoutMs}ms`, {
			target: options.url,
			tab: this.tabResult(tab),
		});
	}

	async resolveTarget(tabId: string, ref: string): Promise<{ x: number; y: number; label: string }> {
		const tab = this.requireTab(tabId, "resolveTarget");
		const client = this.requireClient();
		const resolved = await resolveRefToBox(client, tabHandleOf(tab), ref);
		if (!resolved.ok) throw new Error(resolved.reason);
		return { x: resolved.x, y: resolved.y, label: ref };
	}

	async click(tabId: string, options: AiraBrowserClickOptions): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("click", `unknown tab ${tabId}`);
		const client = this.requireClient();
		let x: number | undefined;
		let y: number | undefined;
		let label = elementTargetLabel(options);
		if (options.ref) {
			const resolved = await resolveRefToBox(client, tabHandleOf(tab), options.ref);
			if (!resolved.ok) return failResult("click", resolved.reason, { target: options.ref });
			x = resolved.x;
			y = resolved.y;
			label = `[${options.ref}]`;
		} else {
			x = options.x;
			y = options.y;
		}
		if (x === undefined || y === undefined) {
			return failResult("click", "click needs a ref or (x, y) coordinates");
		}
		const dispatched = await dispatchClick(
			client,
			tab.cdp.sessionId,
			x,
			y,
			options.button ?? "left",
			options.count ?? 1,
		);
		if (!dispatched.ok) return failResult("click", dispatched.reason ?? "click dispatch failed", { target: label });

		const changes = await this.interactiveChangeDiff(tab);
		const result = okResult("click", { target: label, tab: this.tabResult(tab) });
		if (changes.length > 0) result.changes = changes.slice(0, 24);
		return this.resultWithEvidence(result, tab);
	}

	async fill(tabId: string, ref: string, value: string | boolean): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("fill", `unknown tab ${tabId}`);
		const client = this.requireClient();
		const backendId = tab.cdp.resolveRef(ref);
		if (backendId === undefined) {
			return failResult("fill", `ref ${ref} is unknown or stale — re-observe the page for fresh refs`, {
				target: ref,
			});
		}
		const filled = await fillByRef(client, tab.cdp.sessionId, backendId, value);
		if (!filled.ok) {
			return failResult("fill", filled.reason ?? "fill failed", { target: ref });
		}
		const changes = await this.interactiveChangeDiff(tab);
		const result = okResult("fill", { target: ref, tab: this.tabResult(tab) });
		if (changes.length > 0) result.changes = changes.slice(0, 24);
		return this.resultWithEvidence(result, tab);
	}

	async pressKey(tabId: string, key: string, modifiers = 0): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("press", `unknown tab ${tabId}`);
		const client = this.requireClient();
		const pressed = await dispatchKey(client, tab.cdp.sessionId, key, modifiers);
		if (!pressed.ok) return failResult("press", pressed.reason ?? "key dispatch failed", { target: key });
		const changes = await this.interactiveChangeDiff(tab);
		const result = okResult("press", { target: key, tab: this.tabResult(tab) });
		if (changes.length > 0) result.changes = changes.slice(0, 24);
		return this.resultWithEvidence(result, tab);
	}

	async scroll(
		tabId: string,
		ref: string | undefined,
		deltaX: number,
		deltaY: number,
	): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("scroll", `unknown tab ${tabId}`);
		const client = this.requireClient();
		let x = 640;
		let y = 400;
		if (ref) {
			const resolved = await resolveRefToBox(client, tabHandleOf(tab), ref);
			if (!resolved.ok) return failResult("scroll", resolved.reason, { target: ref });
			x = resolved.x;
			y = resolved.y;
		}
		const wheel = await client.send(
			"Input.dispatchMouseEvent",
			{ type: "mouseWheel", x, y, deltaX, deltaY },
			tab.cdp.sessionId,
		);
		if (!wheel.ok) return failResult("scroll", wheel.error ?? "wheel dispatch failed");
		return okResult("scroll", { tab: this.tabResult(tab) });
	}

	async wait(
		tabId: string,
		condition: AiraBrowserWaitCondition,
		timeoutMs: number,
	): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("wait", `unknown tab ${tabId}`);
		const client = this.requireClient();
		const deadline = this.now() + timeoutMs;
		if (condition.kind === "time") {
			await sleep(Math.min(condition.ms, timeoutMs));
			return okResult("wait", { tab: this.tabResult(tab) });
		}
		while (this.now() < deadline) {
			if (await this.waitConditionSatisfied(client, tab, condition)) {
				return okResult("wait", { tab: this.tabResult(tab) });
			}
			await sleep(WAIT_POLL_MS);
		}
		return failResult("wait", `condition not met within ${timeoutMs}ms`, { tab: this.tabResult(tab) });
	}

	async evaluate(
		tabId: string,
		options: { expression: string; timeoutMs?: number },
	): Promise<AiraBrowserOperationResult> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return failResult("evaluate", `unknown tab ${tabId}`);
		const client = this.requireClient();
		const result = await client.send(
			"Runtime.evaluate",
			{ expression: options.expression, returnByValue: true, awaitPromise: true },
			tab.cdp.sessionId,
		);
		if (!result.ok) return failResult("evaluate", result.error ?? "evaluation failed");
		const data = result.data as {
			result?: { type?: string; value?: unknown; description?: string };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		};
		if (data.exceptionDetails) {
			const text = data.exceptionDetails.exception?.description ?? data.exceptionDetails.text ?? "page exception";
			return failResult("evaluate", `page exception: ${String(text).slice(0, 400)}`);
		}
		return okResult("evaluate", {
			target: options.expression.slice(0, 80),
			tab: this.tabResult(tab),
			summary: summarizeEvaluatedValue(data.result),
		});
	}

	async consoleEvidence(tabId: string, filter: AiraBrowserEvidenceFilter = {}): Promise<AiraBrowserEvidenceDrain> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return { total: 0, overflowed: false, records: [] };
		return tab.cdp.console.drain(filter.sinceSeq, filter.limit);
	}

	async networkEvidence(tabId: string, filter: AiraBrowserEvidenceFilter = {}): Promise<AiraBrowserEvidenceDrain> {
		const tab = this.tabsById.get(tabId);
		if (!tab) return { total: 0, overflowed: false, records: [] };
		return tab.cdp.network.drain(filter.sinceSeq, filter.limit);
	}

	async screenshot(tabId: string, dir: string, kind: string): Promise<string> {
		const tab = this.requireTab(tabId, "screenshot");
		const client = this.requireClient();
		const shot = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }, tab.cdp.sessionId);
		if (!shot.ok) throw new Error(shot.error ?? "screenshot failed");
		const base64 = (shot.data as { data?: string }).data;
		if (!base64) throw new Error("screenshot returned no data");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${kind}-${Date.now()}.jpg`);
		writeFileSync(path, Buffer.from(base64, "base64"));
		return path;
	}

	async disposeSession(): Promise<AiraBrowserOperationResult> {
		if (this.disposed) {
			return okResult("close", { tab: this.activeTabOf() });
		}
		this.disposed = true;
		if (this.client) {
			this.client.close();
			this.client = undefined;
		}
		this.tabsById.clear();
		this.activeTabIdValue = undefined;
		const later: Promise<unknown>[] = [];
		if (this.child && this.child.exitCode === null) {
			const terminate = this.options.terminate ?? terminateBrowserProcess;
			later.push(terminate(this.child, process.platform, 1500));
		}
		const disposedPid = this.child?.pid;
		this.child = undefined;
		if (disposedPid !== undefined) {
			untrackDetachedChildPid(disposedPid);
		}
		const callbacks = [...this.exitListeners];
		this.exitListeners.clear();
		for (const listener of callbacks) {
			try {
				listener("browser closed");
			} catch {
				// listener must never break teardown
			}
		}
		await Promise.allSettled(later);
		// The profile is Aira-owned and disposable: remove it on close.
		try {
			rmSync(this.options.profileDir, { recursive: true, force: true });
		} catch {
			// best-effort profile cleanup
		}
		return okResult("close");
	}

	async dispose(): Promise<void> {
		await this.disposeSession();
	}

	onBrowserExit(listener: (reason: string) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private requireClient(): CdpClient {
		if (!this.client) throw new Error("browser provider is not connected");
		return this.client;
	}

	private requireTab(tabId: string, operation: string): ProviderTab {
		const tab = this.tabsById.get(tabId);
		if (!tab) throw new Error(`${operation}: unknown tab ${tabId}`);
		return tab;
	}

	private firstTabId(): string | undefined {
		return [...this.tabsById.keys()][0];
	}

	private activeTabOf(): { id: string; url: string; title: string; readyState: string } | undefined {
		const active = this.activeTabIdValue ? this.tabsById.get(this.activeTabIdValue) : undefined;
		return active ? { ...active.record } : undefined;
	}

	private async attachTab(targetId: string): Promise<void> {
		const client = this.requireClient();
		const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
		if (!attached.ok) return;
		const sessionId = (attached.data as { sessionId?: string }).sessionId;
		if (!sessionId) return;
		this.tabCounter += 1;
		const cdp = new CdpTabSession(targetId, sessionId);
		await cdp.enable(client);
		const tab: ProviderTab = {
			record: { id: `tab-${this.tabCounter}`, url: "about:blank", title: "", readyState: "loading" },
			cdp,
		};
		this.tabsById.set(tab.record.id, tab);
		if (!this.activeTabIdValue) this.activeTabIdValue = tab.record.id;
		const info = await client.send("Target.getTargetInfo", { targetId });
		const targetInfo = (info.data as { targetInfo?: { url?: string; title?: string } }).targetInfo;
		if (targetInfo) {
			tab.record = { ...tab.record, url: targetInfo.url ?? "about:blank", title: targetInfo.title ?? "" };
		}
	}

	private onEvent(event: { method: string; params: Record<string, unknown>; sessionId?: string }): void {
		if (event.method === "Target.targetCreated") {
			const info = (event.params as { targetInfo?: { targetId?: string; type?: string; openerId?: string } })
				.targetInfo;
			if (info?.type === "page" && info.targetId && this.isOwnedOpener(info.openerId)) {
				void this.attachTab(info.targetId);
			}
			return;
		}
		if (event.method === "Target.targetDestroyed") {
			const targetId = (event.params as { targetId?: string }).targetId;
			if (targetId) {
				for (const [id, tab] of this.tabsById) {
					if (tab.cdp.targetId === targetId) {
						this.tabsById.delete(id);
						if (this.activeTabIdValue === id) this.activeTabIdValue = this.firstTabId();
						break;
					}
				}
			}
			return;
		}
		// Page-level events route to the owning tab session.
		if (event.sessionId) {
			for (const tab of this.tabsById.values()) {
				if (tab.cdp.sessionId === event.sessionId) {
					tab.cdp.handleEvent({
						method: event.method,
						params: event.params,
						sessionId: event.sessionId,
					});
					break;
				}
			}
		}
	}

	private isOwnedOpener(openerId: string | undefined): boolean {
		if (!openerId) return false;
		for (const tab of this.tabsById.values()) {
			if (tab.cdp.targetId === openerId) return true;
		}
		return false;
	}

	private onConnectionClosed(reason: string): void {
		if (this.closedReason || this.disposed) return;
		this.closedReason = reason;
		this.tabsById.clear();
		this.activeTabIdValue = undefined;
		this.notifyExit(reason);
	}

	private onBrowserExited(code: number | null, signal: string | null): void {
		if (this.closedReason || this.disposed) return;
		if (this.child?.pid !== undefined) {
			untrackDetachedChildPid(this.child.pid);
		}
		this.closedReason = `browser process exited (code ${code ?? "?"}, signal ${signal ?? "none"})`;
		try {
			this.client?.close();
		} catch {
			// already closed
		}
		this.notifyExit(this.closedReason);
	}

	private notifyExit(reason: string): void {
		for (const listener of this.exitListeners) {
			try {
				listener(reason);
			} catch {
				// listener must never break the provider
			}
		}
	}

	private async pageInfo(tab: ProviderTab): Promise<{ url: string; title: string; readyState: string }> {
		const client = this.requireClient();
		const doc = await client.send(
			"Runtime.evaluate",
			{
				expression: "({ url: location.href, title: document.title, readyState: document.readyState })",
				returnByValue: true,
			},
			tab.cdp.sessionId,
		);
		if (doc.ok) {
			const value = (doc.data as { result?: { value?: { url?: string; title?: string; readyState?: string } } })
				.result?.value;
			if (value) {
				return { url: value.url ?? "", title: value.title ?? "", readyState: value.readyState ?? "unknown" };
			}
		}
		return { ...tab.record };
	}

	private tabResult(tab: ProviderTab): { id: string; url: string; title: string; readyState: string } {
		return { ...tab.record };
	}

	private resultWithEvidence(result: AiraBrowserOperationResult, tab: ProviderTab): AiraBrowserOperationResult {
		const consoleSummary = tab.cdp.console.summary();
		const networkSummary = tab.cdp.network.summary();
		result.console = {
			errors: consoleSummary.errors,
			warnings: consoleSummary.warnings,
			total: consoleSummary.total,
			topFinding: consoleSummary.topFinding,
		};
		result.network = { failures: networkSummary.failures, topFinding: networkSummary.topFinding };
		return result;
	}

	/** Compact interactive-element diff after a mutation (bounded). */
	private async interactiveChangeDiff(
		tab: ProviderTab,
	): Promise<Array<{ kind: "changed" | "new" | "removed"; ref: string; role: string; name: string }>> {
		try {
			const client = this.requireClient();
			const ax = await client.send("Accessibility.getFullAXTree", {}, tab.cdp.sessionId);
			if (!ax.ok) return [];
			const rawNodes = ((ax.data as { nodes?: unknown[] }).nodes ?? []) as never;
			const slim = buildSlimAxTree(rawNodes, 300);
			const targets = collectInteractiveTargets(slim);
			const refMap = assignRefs(targets);
			const signatures = new Map<string, string>();
			for (const target of targets) {
				if (target.ref) signatures.set(target.ref, sigOf(target));
			}

			// Previous snapshot: backendId → {ref, sig} (inverted ref map).
			const previousByBackend = new Map<number, { ref: string; sig: string }>();
			for (const [ref, backendId] of tab.cdp.allRefs()) {
				const sig = tab.cdp.signatureOf(ref) ?? "";
				previousByBackend.set(backendId, { ref, sig });
			}

			const changed: Array<{ kind: "changed"; ref: string; role: string; name: string }> = [];
			const added: Array<{ kind: "new"; ref: string; role: string; name: string }> = [];
			for (const target of targets) {
				const ref = target.ref;
				const backendId = ref ? refMap.get(ref) : undefined;
				if (!ref || backendId === undefined) continue;
				const prior = previousByBackend.get(backendId);
				if (prior && prior.ref === ref) {
					if (prior.sig !== sigOf(target) && prior.sig !== "") {
						changed.push({ kind: "changed", ref, role: target.role, name: target.name ?? "" });
					}
				} else if (prior && prior.ref !== ref) {
					// Element re-assigned a ref after re-render: report as changed.
					changed.push({ kind: "changed", ref, role: target.role, name: target.name ?? "" });
				} else {
					added.push({ kind: "new", ref, role: target.role, name: target.name ?? "" });
				}
			}
			const removed: Array<{ kind: "removed"; ref: string; role: string; name: string }> = [];
			for (const [backendId, prior] of previousByBackend) {
				if (![...refMap.values()].includes(backendId) && prior.ref.startsWith("e")) {
					const parts = prior.sig.split("|");
					removed.push({ kind: "removed", ref: prior.ref, role: parts[0] ?? "element", name: parts[1] ?? "" });
				}
			}

			const page = await this.pageInfo(tab);
			tab.cdp.setRefs(refMap, signatures, page.url);
			const out: Array<{ kind: "changed" | "new" | "removed"; ref: string; role: string; name: string }> = [
				...changed,
				...added,
				...removed,
			];
			return out;
		} catch {
			return [];
		}
	}

	/** Resolve interactive targets with viewport boxes (bounded). */
	private async targetsWithBoxes(slim: SlimAxNode[], tab: ProviderTab, pageUrl: string): Promise<AiraBrowserTarget[]> {
		const client = this.requireClient();
		const targets = collectInteractiveTargets(slim);
		const refMap = assignRefs(targets);
		const signatures = new Map<string, string>();
		const out: AiraBrowserTarget[] = [];
		let budget = BOX_BUDGET_PER_OBSERVE;
		for (const target of targets) {
			const ref = target.ref;
			const backendId = ref ? refMap.get(ref) : undefined;
			if (!ref || backendId === undefined) continue;
			signatures.set(ref, sigOf(target));
			const entry: AiraBrowserTarget = {
				ref,
				role: target.role,
				name: target.name,
				value: target.value,
				state: target.state,
			};
			if (budget > 0) {
				const box = await boxCenterOf(client, tab.cdp.sessionId, backendId);
				if (box) {
					entry.x = Math.round(box.x);
					entry.y = Math.round(box.y);
				}
				budget -= 1;
			}
			// Refresh live values for VALUE_ROLES (AX value is stale after typing).
			if (VALUE_ROLE_SET.has(target.role) || (target.role === "textbox" && target.value !== undefined)) {
				const live = await readLiveValue(client, tab.cdp.sessionId, backendId);
				if (live !== undefined) entry.value = live;
			}
			out.push(entry);
		}
		tab.cdp.setRefs(refMap, signatures, pageUrl);
		return out;
	}

	private async waitConditionSatisfied(
		client: CdpClient,
		tab: ProviderTab,
		condition: AiraBrowserWaitCondition,
	): Promise<boolean> {
		if (condition.kind === "ready") {
			const info = await this.pageInfo(tab);
			return condition.readyState === "complete" ? info.readyState === "complete" : info.readyState !== "loading";
		}
		if (condition.kind === "url") {
			const info = await this.pageInfo(tab);
			return info.url.includes(condition.substring);
		}
		const expression =
			condition.kind === "selector"
				? `(() => { try { return document.querySelector(${JSON.stringify(condition.selector)}) !== null; } catch { return false; } })()`
				: condition.kind === "text"
					? `(() => Boolean(document.body && document.body.innerText.includes(${JSON.stringify(condition.text)})))()`
					: "false";
		const result = await client.send("Runtime.evaluate", { expression, returnByValue: true }, tab.cdp.sessionId);
		return result.ok && (result.data as { result?: { value?: boolean } }).result?.value === true;
	}
}

// =========================================================================
// Helpers
// =========================================================================

function sigOf(node: SlimAxNode): string {
	return `${node.role}|${node.name ?? ""}|${node.value ?? ""}|${node.state ?? ""}`;
}

function summarizeEvaluatedValue(result: { type?: string; value?: unknown; description?: string } | undefined): string {
	if (!result || result.type === "undefined") return "undefined";
	if (result.type === "string") return JSON.stringify(result.value);
	if (result.type === "number" || result.type === "boolean") return String(result.value);
	if (result.type === "object" && result.value === null) return "null";
	if (result.type === "object") {
		try {
			return JSON.stringify(result.value);
		} catch {
			return result.description ?? result.type;
		}
	}
	return result.description ?? String(result.value);
}

function tabHandleOf(tab: ProviderTab): {
	targetId: string;
	sessionId: string;
	resolveRef(ref: string): number | undefined;
} {
	return {
		targetId: tab.cdp.targetId,
		sessionId: tab.cdp.sessionId,
		resolveRef: (ref) => tab.cdp.resolveRef(ref),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Roles whose live value is refreshed from the DOM. */
const VALUE_ROLE_SET = new Set([
	"textbox",
	"searchbox",
	"spinbutton",
	"combobox",
	"checkbox",
	"radio",
	"switch",
	"slider",
]);

/** Factory for tests. */
export function createCdpBrowserProvider(options: CdpBrowserProviderOptions): CdpBrowserProvider {
	return new CdpBrowserProvider(options);
}
