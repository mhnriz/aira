/**
 * Aira browser — interaction primitives over CDP.
 *
 * The smallest robust interaction surface for local web verification:
 * click (compositor-level mouse events), fill/select/check (framework-safe
 * native value setter inside the page), key press, scroll, limited
 * evaluation, and bounded waits. Ref-first targeting: a ref resolves to the
 * backend node at action time; stale refs fail truthfully with a typed
 * reason, never silently hitting a different element.
 */
import type { CdpClient } from "./client.ts";

export interface CdpTabHandle {
	targetId: string;
	sessionId: string;
	resolveRef(ref: string): number | undefined;
	/** Page URL when the refs were assigned (cross-navigation staleness). */
	refPageUrl?: string;
}

const CLICK_TIMEOUT_MS = 5_000;
const EVALUATE_TIMEOUT_MS = 10_000;

/** Resolve a ref to live viewport coordinates of the element. */
export async function boxCenterOf(
	client: CdpClient,
	sessionId: string,
	backendId: number,
): Promise<{ x: number; y: number } | undefined> {
	const box = await client.send("DOM.getBoxModel", { backendNodeId: backendId }, sessionId);
	if (!box.ok || !box.data) return undefined;
	const quad = (box.data as { model?: { border?: number[] } }).model?.border;
	if (!quad || quad.length < 8) return undefined;
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	return {
		x: (Math.min(...xs) + Math.max(...xs)) / 2,
		y: (Math.min(...ys) + Math.max(...ys)) / 2,
	};
}

/** Element state read used for ref staleness checks. */
export async function readElementState(
	client: CdpClient,
	sessionId: string,
	backendId: number,
): Promise<{ connected?: boolean; tag?: string } | undefined> {
	const resolved = await client.send("DOM.resolveNode", { backendNodeId: backendId }, sessionId);
	if (!resolved.ok) return undefined;
	const objectId = (resolved.data as { object?: { objectId?: string } }).object?.objectId;
	if (!objectId) return undefined;
	const state = await client.send(
		"Runtime.callFunctionOn",
		{
			objectId,
			functionDeclaration:
				"function () { return { connected: this && this.isConnected === true, tag: this && this.tagName ? this.tagName.toLowerCase() : undefined }; }",
			returnByValue: true,
		},
		sessionId,
	);
	if (!state.ok) return undefined;
	return (state.data as { result?: { value?: { connected?: boolean; tag?: string } } }).result?.value;
}

/**
 * Resolve a ref target to coordinates; returns a typed outcome so the
 * provider can fail truthfully ("stale ref", "element not visible", ...).
 */
export async function resolveRefToBox(
	client: CdpClient,
	tab: CdpTabHandle,
	ref: string,
): Promise<{ ok: true; x: number; y: number } | { ok: false; reason: string }> {
	const backendId = tab.resolveRef(ref);
	if (backendId === undefined) {
		return { ok: false, reason: `ref ${ref} is unknown or stale — re-observe the page for fresh refs` };
	}
	// Cross-navigation staleness: CDP backend node ids are reused across
	// documents, so a ref MUST NOT silently target a node in a different
	// page. Compare the live document URL to the URL at ref-assignment time.
	if (tab.refPageUrl !== undefined) {
		const live = await client.send(
			"Runtime.evaluate",
			{ expression: "location.href", returnByValue: true },
			tab.sessionId,
		);
		const liveUrl = live.ok ? (live.data as { result?: { value?: unknown } }).result?.value : undefined;
		if (typeof liveUrl === "string" && liveUrl !== tab.refPageUrl) {
			return {
				ok: false,
				reason: `ref ${ref} is stale (the page navigated since the observation) — re-observe for fresh refs`,
			};
		}
		// An unreadable execution context means the document itself changed
		// (mid-navigation, page error): the ref cannot be confirmed against the
		// live document, so refusing is the truthful outcome.
		if (liveUrl === undefined && !live.ok) {
			return {
				ok: false,
				reason: `ref ${ref} is stale (the page state changed since the observation) — re-observe for fresh refs`,
			};
		}
	}
	const state = await readElementState(client, tab.sessionId, backendId);
	if (state === undefined) {
		return { ok: false, reason: `ref ${ref} is stale (element no longer resolves) — re-observe the page` };
	}
	if (!state.connected) {
		return { ok: false, reason: `ref ${ref} is stale (element detached from the document) — re-observe the page` };
	}
	const box = await boxCenterOf(client, tab.sessionId, backendId);
	if (box === undefined) {
		return { ok: false, reason: `ref ${ref} has no box (element not rendered)` };
	}
	return { ok: true, ...box };
}

/** Dispatch a compositor-level mouse click (move → press → release). */
export async function dispatchClick(
	client: CdpClient,
	sessionId: string,
	x: number,
	y: number,
	button: "left" | "right" | "middle",
	count: number,
): Promise<{ ok: boolean; reason?: string }> {
	const moved = await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
	if (!moved.ok) return { ok: false, reason: moved.error };
	const pressed = await client.send(
		"Input.dispatchMouseEvent",
		{ type: "mousePressed", x, y, button, clickCount: count },
		sessionId,
	);
	if (!pressed.ok) return { ok: false, reason: pressed.error };
	const released = await client.send(
		"Input.dispatchMouseEvent",
		{ type: "mouseReleased", x, y, button, clickCount: count },
		sessionId,
	);
	if (!released.ok) return { ok: false, reason: released.error };
	return { ok: true };
}

/** Read back the live value/checked state of a ref (post-fill verification). */
export async function readLiveValue(
	client: CdpClient,
	sessionId: string,
	backendId: number,
): Promise<string | undefined> {
	const resolved = await client.send("DOM.resolveNode", { backendNodeId: backendId }, sessionId);
	if (!resolved.ok) return undefined;
	const objectId = (resolved.data as { object?: { objectId?: string } }).object?.objectId;
	if (!objectId) return undefined;
	const value = await client.send(
		"Runtime.callFunctionOn",
		{
			objectId,
			functionDeclaration:
				"function () { if (!this) return null; if (this.type === 'checkbox' || this.type === 'radio') { return this.checked ? 'checked' : 'unchecked'; } if (typeof this.value === 'string') return this.value; return null; }",
			returnByValue: true,
		},
		sessionId,
	);
	if (!value.ok) return undefined;
	const raw = (value.data as { result?: { value?: unknown } }).result?.value;
	return typeof raw === "string" ? raw : undefined;
}

/**
 * The framework-safe fill engine: runs INSIDE the page against the ref's
 * element. Uses the native prototype value setter (React/Vue controlled
 * inputs keep the written value) and dispatches bubbling input/change.
 * Handles text inputs, textareas, contenteditable, selects, checkboxes and
 * radios.
 */
export const FILL_ENGINE = `
  const el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: "ref does not point to an element" };
  const tagName = el.tagName || "";
  const tag = tagName.toLowerCase();
  const type = (el.type || "").toLowerCase();
  const value = __airaValue;
  if (el.disabled) return { ok: false, reason: "element is disabled", tag: tagName };
  const fire = function (t) { el.dispatchEvent(new Event(t, { bubbles: true })); };
  try { el.focus(); } catch (e) {}
  if (tag === "select") {
    const want = String(value);
    let matched = null;
    for (let i = 0; i < el.options.length; i++) {
      const o = el.options[i];
      if (o.value === want || o.label === want || o.text === want) { matched = o; break; }
    }
    if (!matched) {
      const opts = [];
      for (let i = 0; i < el.options.length; i++) opts.push({ value: el.options[i].value, text: el.options[i].text });
      return { ok: false, reason: "no matching option", kind: "select", options: opts, tag: tagName };
    }
    el.value = matched.value;
    fire("input"); fire("change");
    return { ok: true, kind: "select", value: el.value, text: matched.text, tag: tagName };
  }
  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    const want = value === true || value === "true" || value === "on";
    let changed = false;
    if (el.checked !== want) {
      try { el.click(); } catch (e) {}
      if (el.checked !== want) { el.checked = want; fire("input"); fire("change"); }
      changed = true;
    }
    return { ok: true, kind: type, checked: el.checked, changed: changed, tag: tagName };
  }
  if (el.isContentEditable) {
    let done = false;
    try {
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); const rng = document.createRange(); rng.selectNodeContents(el); sel.addRange(rng); }
      done = document.execCommand("insertText", false, String(value));
    } catch (e) { done = false; }
    if (!done) {
      el.textContent = String(value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    return { ok: true, kind: "contenteditable", value: el.textContent || "", tag: tagName };
  }
  if (tag === "input" || tag === "textarea") {
    const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    fire("input"); fire("change");
    return { ok: true, kind: el.type || tag, value: el.value, tag: tagName };
  }
  return { ok: false, reason: "element is not a fillable field (tag=" + tag + ")", tag: tagName };
`;

/** Fill a field by ref. Returns the engine's structured outcome. */
export async function fillByRef(
	client: CdpClient,
	sessionId: string,
	backendId: number,
	value: string | boolean,
): Promise<{ ok: boolean; reason?: string; outcome?: Record<string, unknown> }> {
	const resolved = await client.send("DOM.resolveNode", { backendNodeId: backendId }, sessionId);
	if (!resolved.ok) return { ok: false, reason: resolved.error };
	const objectId = (resolved.data as { object?: { objectId?: string } }).object?.objectId;
	if (!objectId) return { ok: false, reason: "ref does not resolve to an element" };
	const result = await client.send(
		"Runtime.callFunctionOn",
		{
			objectId,
			functionDeclaration: `function (__airaValue) {\n${FILL_ENGINE}\n}`,
			arguments: [{ value }],
			returnByValue: true,
		},
		sessionId,
	);
	if (!result.ok) return { ok: false, reason: result.error };
	const outcome = (result.data as { result?: { value?: Record<string, unknown> } }).result?.value;
	if (!outcome || outcome.ok !== true) {
		return { ok: false, reason: String(outcome?.reason ?? "fill failed"), outcome };
	}
	return { ok: true, outcome };
}

/** Dispatch a key at the focused element (CDP Input.dispatchKeyEvent). */
export async function dispatchKey(
	client: CdpClient,
	sessionId: string,
	key: string,
	modifiers: number,
): Promise<{ ok: boolean; reason?: string }> {
	const result = await client.send(
		"Input.dispatchKeyEvent",
		{ type: "keyDown", key, code: keyToCode(key), modifiers, windowsVirtualKeyCode: keyToVk(key) },
		sessionId,
	);
	if (!result.ok) return { ok: false, reason: result.error };
	await client.send(
		"Input.dispatchKeyEvent",
		{ type: "keyUp", key, code: keyToCode(key), modifiers, windowsVirtualKeyCode: keyToVk(key) },
		sessionId,
	);
	return { ok: true };
}

/** Text insertion (fill alternative: types into the focused element). */
export async function insertText(
	client: CdpClient,
	sessionId: string,
	text: string,
): Promise<{ ok: boolean; reason?: string }> {
	const result = await client.send("Input.insertText", { text }, sessionId);
	if (!result.ok) return { ok: false, reason: result.error };
	return { ok: true };
}

export function keyToCode(key: string): string {
	const map: Record<string, string> = {
		Enter: "Enter",
		Tab: "Tab",
		Backspace: "Backspace",
		Delete: "Delete",
		Escape: "Escape",
		ArrowLeft: "ArrowLeft",
		ArrowRight: "ArrowRight",
		ArrowUp: "ArrowUp",
		ArrowDown: "ArrowDown",
		Home: "Home",
		End: "End",
		PageUp: "PageUp",
		PageDown: "PageDown",
	};
	return map[key] ?? "KeyA";
}

export function keyToVk(key: string): number {
	const map: Record<string, number> = {
		Enter: 13,
		Tab: 9,
		Backspace: 8,
		Delete: 46,
		Escape: 27,
		ArrowLeft: 37,
		ArrowRight: 39,
		ArrowUp: 38,
		ArrowDown: 40,
		Home: 36,
		End: 35,
		PageUp: 33,
		PageDown: 34,
	};
	return map[key] ?? 0;
}

export { CLICK_TIMEOUT_MS, EVALUATE_TIMEOUT_MS };
