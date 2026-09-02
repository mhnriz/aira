# Phase 12.1 — Native Multi-Pane Viewports & Scrolling

> Status: ✅ done
> Predecessor: `PHASE_12_NATIVE_WORKBENCH_UI.md` (accepted).
> Scope: focused UI architecture enhancement. No backend, Goal, orchestration,
> verification, permissions, tasks, browser, execution, or intelligence
> semantics changed. Phase 13 not begun.

## 1. Why terminal scrollback was insufficient

Phase 12 delivered a native Workbench and a restrained application shell, but
navigation still leaned on the host terminal scrollbar. That meant:

- The conversation transcript and the Workbench shared one scrollback; neither
  could keep an independent reading position.
- Scrolling the transcript moved the header/composer/footer along with it
  (the Aira header lived inside the scrollable document).
- There was no way to read older conversation while watching live Workbench
  state, no unread/new-output signal, and no clear "am I at live output?"
  answer.

The desired product behavior is a proper terminal application: independent
Aira-owned viewports inside a fixed shell, not host-terminal scrollback.

## 2. Existing Pi fullscreen infrastructure (reused, not reinvented)

`packages/tui/src/tui-alt-screen.ts` (the fullscreen renderer) already owned a
complete viewport story:

- **Layout tree** (`layout.ts`): `renderLayoutFrame` computes a layout with
  boxes, clips, and `LayoutBox.scrollView` entries; `getScrollViewsAt` finds
  the scroll views under a pointer coordinate; `getScrollViewBox` maps a
  scroll view to its on-screen box.
- **ScrollView** (`components/scroll-view.ts`): independent `scrollTop`,
  follow-end semantics, overscroll chain/contain, transient auto scrollbar.
- **Mouse wheel routing** (`routeWheel`): routes to the pane under the
  pointer, chains/contains, falls back to the primary view.
- **Selection**: press/drag/release with per-scroll-view source lines, word/
  line granularity, edge autoscroll, OSC 52 or injected clipboard copy.
- **Follow output**: `isFollowingEnd`, `scrollToEnd`, no yank on new content.
- **Prompt-jump, search, scrollbar drag, resize handling** via the layout.

Phase 12 already put the Workbench in its own `ScrollView`
(`follow: "none"`, `overscroll: "contain"`, auto scrollbar) inside the
fullscreen `HStack`, so the mouse wheel already scrolled whichever pane sat
under the pointer. What was missing was the rest of the shell behavior.

## 3. What was reused vs changed

Reused as-is:

- The fullscreen renderer, layout tree, ScrollView, follow semantics, wheel
  routing, selection, search, prompt-jump, scrollbars, resize clamping.

Generalized (small, additive — `packages/tui`):

- `ScrollView` gained `getUnreadLines()` and `maxScrollTop` so a host can
  report how much newer output sits below a scrolled-away viewport.
- `TuiAltScreen` gained `setKeyboardScrollTarget(scrollView)`: unmodified
  keyboard viewport navigation (PageUp/PageDown, half-page/line scroll,
  Home/End) targets that scroll view instead of the primary. When unset it
  targets the primary (transcript). `ViewportTUI` declares the method.

Changed (Aira shell — `packages/coding-agent`):

- The Aira header moved OUT of the scrollable document into the fixed layout
  root (full width, above the pane split); composer dock and status rail were
  already fixed.
- Conversation pane gained a fixed `CONVERSATION` title strip; the Workbench's
  `ENGINEERING CONTEXT` title strip (title/subtitle/separator) was extracted
  out of the scrollable panels into a fixed pane header.
- New `app.viewport.focusCycle` action (`Alt+O`), `viewportFocus` UI state,
  and keyboard-target wiring.
- New one-line transcript new-output indicator and the Workbench
  live/history subtitle.
- Default interactive mode switched to fullscreen.

## 4. Final pane architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ AIRA WORKBENCH                                      BUILD · MODEL    │  fixed header
├──────────────────────────────────────────┬───────────────────────────┤
│ CONVERSATION ●                           │ ENGINEERING CONTEXT       │  pane titles
│ ┌──────────────────────────────────────┐ │ ┌───────────────────────┐ │
│ │ independently scrollable transcript  │ │ │ independently        │ │
│ │ viewport (own scrollTop + follow)    │ │ │ scrollable Workbench  │ │
│ │                                      │ │ │ panels (own scrollTop)│ │
│ └──────────────────────────────────────┘ │ └───────────────────────┘ │
│ ↓ N new lines                             │                          │  transient indicator
├──────────────────────────────────────────┴───────────────────────────┤
│ COMPOSER / dock                                                       │  fixed
├──────────────────────────────────────────────────────────────────────┤
│ STATUS RAIL / footer                                                  │  fixed
└──────────────────────────────────────────────────────────────────────┘
```

Layout root (fullscreen): `VStack[ header, HStack[ conversationColumn,
workbenchColumn ], dock, footer ]` where each column is
`VStack[ title strip, ScrollView(panels/transcript) ]`. The Workbench column
hides via its `visible(viewport)` callback (responsive auto-hide unchanged);
when hidden, the conversation column takes the full width.

## 5. Fullscreen default decision (ADR-037)

`SettingsManager.getTuiMode()` now resolves an unset `tuiMode` to `fullscreen`.
Aira's canonical interactive experience is the native multi-pane viewport
shell. Regular (terminal-scrollback) mode remains the explicit compatibility
mode via `tuiMode: "regular"` or `--tui-mode regular` and renders the Workbench
as a viewport-fixed rail. Regular mode does not attempt independent panes —
it fundamentally renders through terminal scrollback, so it stays a simpler
compatibility UI. CLI help and the settings comment document the default.

## 6. Scroll / follow model

- **Conversation** (`ScrollView`, `follow: "end"`, `primary: true`): at the
  bottom, new output follows automatically. A manual scroll (wheel, PageUp,
  Home) sets `followingEnd = false`; the viewport anchors and new output never
  yanks it. `End` / jump-to-bottom restores follow, clamps to the end, and
  clears the indicator.
- **Workbench** (`ScrollView`, `follow: "none"`, `overscroll: "contain"`):
  starts at the top, scrolls independently, clamps after every projection
  change, and keeps its offset across panel churn and hide/show. If the user
  is at the bottom when content grows, it stays at the bottom; a manual
  upward scroll is never yanked.
- **New-output indicator**: `getUnreadLines()` (content below the viewport)
  drives a one-line `↓ N new lines` row that occupies zero layout space when
  idle. It appears only when the conversation is scrolled away from live
  output and clears on `End`.
- **Live vs history**: the Workbench title subtitle reads
  `CANONICAL STATE · TOKEN-FREE` at the live bottom and
  `LIVE STATE · VIEWING HISTORY` while the transcript reads history. No
  historical Workbench snapshots are persisted — the Workbench is always
  current canonical state.

## 7. Mouse routing

Unchanged architecture, verified for two panes: the fullscreen renderer routes
wheel/trackpad to the scroll view under the pointer (`getScrollViewsAt`).
Wheel over the conversation scrolls the conversation; wheel over the Workbench
scrolls the Workbench; wheel over the composer/footer (no scroll view) falls
back to the primary transcript. No keyboard focus change is required for mouse
scrolling, and mouse scrolling does not steal pane focus.

## 8. Keyboard focus model

`viewportFocus: "conversation" | "workbench"` is interactive-only UI state
(never `AiraSessionState`). Default: conversation. `Alt+O`
(`app.viewport.focusCycle`) cycles it; a hidden Workbench cannot take focus.
When the Workbench is the target, unmodified PageUp/PageDown/Home/End/line
scroll navigate it via `setKeyboardScrollTarget`; the transcript is untouched.
When focus cycles back to the conversation, navigation returns to the
transcript. If the focused Workbench auto-hides (narrow resize or toggle),
focus returns to the conversation and the target is cleared, so restoring the
Workbench can never trap keyboard navigation.

Selected shortcut: **`Alt+O`** — audited against the full table. It joins the
"O" family (`Ctrl+O` tool expansion, `Ctrl+Shift+O` Workbench toggle) without
stealing `Ctrl+A` (editor line-start), either `Ctrl+O` binding, or any
terminal-reserved combination. It is configurable via `keybindings.json` and
reported by `/doctor` (`viewport focus shortcut`).

## 9. Selection / copy

Unchanged renderer behavior, now exercised across both panes: press/drag/
release selects within the pane where the drag starts (pane-scoped; the
selection never jumps panes), supports word/line granularity, copies the
rendered text (native clipboard with verified success, else OSC 52), and works
with an internally scrolled transcript. Composer selection/input is untouched.

## 10. Resize

The layout tree + ScrollView clamping already handle resize: offsets clamp to
the new maxScrollTop, follow-at-bottom is preserved across reflow, the
Workbench auto-hides below the safe minimum and restores on widening (explicit
off stays off). The 1-row indicator and fixed titles keep the shell stable
through wide → medium → narrow → wide cycles.

## 11. Regular / fullscreen compatibility

- **Fullscreen** — canonical: independent viewports, fixed shell, all Phase
  12.1 features.
- **Regular** — compatibility: terminal-scrollback document + viewport-fixed
  Workbench rail (priority panel dropping). The header stays a full-width
  block above the document; the rail never paints over it or the footer.

## 12. Performance

Rendering is token-free (projections from canonical snapshots only). Scrolling
touches only viewport/UI state and requests a render; the per-frame render
cache is rebuilt each frame so the indicator/titles read live state without
extra callbacks. No polling, no new subsystem work, no model calls. Rapid
wheel, PageUp spam, streaming-while-scrolled, and Workbench churn were all
observed without flicker or runaway CPU.

## 13. Terminal limitations

- `Ctrl+Shift+O` and `Ctrl+Shift+E` require a terminal/tmux that distinguishes
  shift-modified Ctrl keys (e.g. Kitty keyboard protocol, or `extended-keys`
  in tmux); the Workbench toggle is still reachable via `/workbench on|off`.
- Mouse routing requires the SGR/button-motion reporting the fullscreen
  renderer already enables.
- Regular mode cannot offer independent panes honestly (terminal scrollback);
  it stays the compatibility surface.

## 14. Dogfood (real built binary, tmux 142×40)

- **CASE A — long transcript**: a 60–80 fact streamed response filled several
  viewports; PageUp/Home walked history inside the viewport.
- **CASE B — streaming while reading history**: scrolling up mid-stream kept
  the reading position anchored (facts 25–38 stayed put while the response
  grew), the `↓ N new lines` indicator counted below, `End` returned to the
  live bottom and cleared the indicator.
- **CASE C — Workbench overflow**: goal + tasks + two delegated agents + a
  background dev process overflowed the sidebar; the Workbench scrolled
  independently (revealing the lower CONTROL panel).
- **CASE D — pointer routing**: wheel over the conversation scrolled it; wheel
  over the Workbench scrolled the Workbench.
- **CASE E — keyboard target**: `Alt+O` moved the focus mark; PageDown/PageUp
  then moved only the Workbench while the transcript stayed anchored, and
  vice versa after cycling back.
- **CASE F — resize**: wide → narrow (Workbench auto-hid, no corruption) →
  wide (restored, offsets/follow sensible); medium width kept a narrower
  Workbench.
- **CASE G — selection**: drag-select + copy in both panes flashed
  `Copied!`; copied text was pane-scoped.
- **CASE H — live/history label**: scrolling the conversation away from the
  bottom showed `LIVE STATE · VIEWING HISTORY`; `End` restored
  `CANONICAL STATE · TOKEN-FREE`.
- **CASE I — tmux**: the entire session ran inside tmux with no escape-
  sequence corruption across scrolls, resizes, and selections.
- Browser dogfood was limited by this machine having no Chrome/Chromium
  binary (the Browser panel is covered by unit tests and the projection
  layer); the browser permission flow itself (ASK panel, allow) was exercised
  live.

## 15. Tests

- `packages/tui/test/tui-multipane.test.ts` (new): independent offsets, wheel
  routing per pane, keyboard scroll target, unread getter + End clearing,
  resize clamping, fixed footer with two scrolling panes.
- `packages/coding-agent/test/aira/native-viewports.test.ts` (new): title
  focus marks, live/history subtitle, new-output indicator rendering, full
  shell layout (fixed header/footer, independent scrolling, keyboard focus
  targeting, indicator/label/End flow, pane-scoped selection).
- `packages/coding-agent/test/interactive-tui.test.ts` (extended): viewport
  focus wiring (cycle + hidden-Workbench reset).
- `packages/coding-agent/test/aira/workbench-keybindings.test.ts` (extended):
  `app.viewport.focusCycle` = `alt+o`, no `Ctrl+A` theft, O-family distinct,
  toggle intact, no conflicts.
- `packages/coding-agent/test/settings-manager.test.ts`: fullscreen default.
- `packages/coding-agent/test/aira/commands/doctor.test.ts`: new
  `viewport focus shortcut` check.
- Full focused suites green (624 aira tests + tui viewport suites); `npm run
  check` green before every commit.

## 16. ADR

ADR-037 (fullscreen-first with native viewports) appended to
`DECISIONS.md`.

## 17. Local commits (this phase)

1. `15891f614` feat(tui): generalize fullscreen viewport — keyboard scroll
   target + unread getters.
2. `5bdc4a674` feat(coding-agent): native multi-pane viewports — fixed shell,
   pane focus, new-output indicator.
3. `4baeb90aa` feat(coding-agent): default Aira interactive mode to fullscreen
   viewports.
4. `0e59cacda` test(coding-agent): multi-pane viewport behavior — focus
   routing, indicator, live/history, focus reset.

Nothing pushed; working tree clean.
