# Phase 12 — Native Workbench & UI Overhaul

> Status: ✅ done · 2026-08-31
> Visual source of truth: `aira_product_docs/AIRA_WORKBENCH_AIRA_ZHR.html` (the
> aira-zhr-themed mockup re-baselined at the start of this phase; the original
> `AIRA_WORKBENCH_MOCKUP.html` was renamed to it — see the baseline commit).
> Reference laboratory: `~/proj/aira-reference/extensions/pi-atelier` (read-only).

## 1. Reference study — Pi Atelier (`~/proj/aira-reference/extensions/pi-atelier`)

### 1.1 Provenance

- Path: `~/proj/aira-reference/extensions/pi-atelier` (package `pi-atelier`
  v0.10.0, MIT, author Michael, repository
  `github.com/michaelmjhhhh/pi-atelier`).
- Inspected read-only: `src/` (split-pane, sidebar, footer, editor, config,
  state, workspace-pulse, run-activity, palette, settings-workspace, menu,
  metrics, completion-notifier, overlay-lifecycle, activity, display*,
  types), `extensions/index.ts`, `package.json`, `LICENSE`.
- Nothing was imported, installed, or copied into Aira. Aira's Workbench is a
  native host implementation; Atelier is documented purely as implementation
  reference. Aira's binary never loads it (dogfood CASE proves it: the
  Workbench renders without any extension installed).

### 1.2 Architecture inspected

Pi Atelier is a **pi extension** (extension API only) that implements:

- **Split/sidebar via private renderer adapters** (`split-pane.ts`): three
  version-locked monkey patches of the TUI (`PI_084_*` symbols):
  1. regular mode: captures the prototype `render` and shrinks the base width;
  2. fullscreen: swaps `layoutRoot` for an `HStack{main, sidebar}`;
  3. hides a real overlay entry under `showOverlay` with `visible: () => false`
     to keep the UI lifecycle while the actual sidebar renders in the HStack.
  It also re-prioritizes an extension input listener ahead of Pi's viewport
  mouse listener to support divider dragging.
- **Sidebar** (`sidebar.ts` + `sidebar-panels.ts`): a component whose
  `render(width)` is height-aware (a `getHeight` provider) and **drops
  panels by `dropRank` until the content fits** the viewport; built-in panel
  ids (agent/activity/alerts/todos/context/workspace/usage/tools), a
  contributed-panel registry/event protocol, a palette layer mapping roles to
  theme colors, animated "jewels" via `Date.now()` parity ticks.
- **Footer** (`footer.ts`): a single-line segment rail. Each segment has
  `full`/`compact` variants, a `zone` (left/right) and a `dropRank`; REQUIRED
  segments are never dropped (only compacted); right zone is right-aligned
  with a flexible gap; a "working" animation interval runs only while the
  rail shows the activity segment.
- **Workspace pulse** (`workspace-pulse.ts`): versioned, coalesced,
  serialized git inspections (debounced 250 ms) published to the sidebar —
  git processes never run at render frequency.
- **Settings** (`config.ts` + `settings-workspace.ts`): a full persisted
  display-settings workspace (density, segments, sidebar panels, presets).
- **Editor/chrome** (`editor.ts`): a custom composer editor replacing Pi's
  editor for border/focus styling.
- **Control center / notifications** (`menu.ts`, `completion-notifier.ts`):
  an overlay control center, completion notifications.

### 1.3 ADOPT / ADAPT / DEFER / REJECT

| Concept | Verdict | Rationale |
| --- | --- | --- |
| Height-aware sidebar that drops lowest-priority panels until it fits the viewport (regular mode) | **ADOPT** | Same mechanics as the Workbench component's `fitPanelCount` (regular-mode rail). |
| Footer segment model: full/compact variants, dropRank, required-never-dropped, left/right zones | **ADAPT** | Same arbitration shape; Aira derives segments from canonical snapshots through the pure projection layer (no timer/animation state), with a P0..P3 priority model and the highest-priority finding segment. |
| `visible(viewport)` HStack entry for the fullscreen split + independent sidebar ScrollView | **ADAPT** | Native, no monkey patching: Aira's controller builds the HStack directly in InteractiveMode's layout root (Atelier needed prototype patching because it is an extension; Aira owns the host). |
| Coalesced workspace-pulse refresh (versioned debounce) | **ADOPT** | Same pattern for the working-set/symbols canonical seam refresh (`requestWorkingSetRefresh`, 400 ms). |
| Overlay sidebar + base-width shrink for regular mode | **ADAPT** | Same geometry, native: `AiraTuiMainScreen` (a TuiMainScreen subclass) shrinks child widths; the rail is a REAL `showOverlay` entry (top-right, nonCapturing, `visible` callback) — no prototype capture, no version symbols, and the workbench overlay is detached before renderer switches. |
| `PI_084_*` prototype patch adapters | **REJECT** | Version-locked private TUI surgery; Aira owns the renderer and integrates at construction sites. |
| Panel registry / contributed-panel event protocol | **DEFER** | Aira's dynamic priority system needs no third-party panel contributions yet; the pure projection layer is the single panel source. |
| Full display-settings configurator | **DEFER** | Good defaults matter more; only four Workbench settings exist (`enabled`, `showOnStartup`, `density`, `width`), matching the product direction. |
| Density modes | **ADOPT (baseline only)** | `comfortable`/`compact` are accepted in settings; the renderer currently treats them identically (shared spacing constants) — the mockup density is the baseline. |
| Working-dot animation, jewels, control center, completion notifications | **REJECT** | Restrained design language; no fidgeting UI, no rainbow telemetry. |
| Atelier's visual styling | **REJECT** | The HTML mockup is the design source of truth. |

## 2. Design source of truth

`aira_product_docs/AIRA_WORKBENCH_AIRA_ZHR.html` — the aira-zhr-themed
workbench mockup (dark warm-neutral, monospace-first, thin separators, flat
panels, conversation primary, engineering sidebar secondary). Preserved
verbatim; used for hierarchy, density, panel ordering, semantic color use,
and footer composition.

## 3. Architecture

### 3.1 Modules introduced

```text
src/aira/ui/                         PURE projection layer (headless-safe)
├── types.ts                         WorkbenchPanel/Row/FooterSegment/Finding/
│                                    Projection input+output, semantic roles
├── priority.ts                      (folded into types/panels)
├── visibility.ts                    responsive policy (single source of truth)
├── finding.ts                       highest-priority finding arbitration
├── footer.ts                        footer segment builders + drop ranks
├── panels.ts                        per-panel projection builders
├── projection.ts                    projectWorkbench() orchestrator
└── index.ts                         headless-safe export surface

src/modes/interactive/workbench/     TUI renderer (interactive only)
├── controller.ts                    WorkbenchController (visibility state,
│                                    canonical subscriptions, coalesced
│                                    working-set/symbols refresh, rail+split,
│                                    lifecycle)
├── workbench-component.ts           sidebar renderer (semantic roles → theme)
└── tui-rail.ts                      AiraTuiMainScreen (regular-mode width
                                    shrink + full-width children)
```

Canonical seams added (state stays in the subsystems):

- `AiraIntelligenceStatus.findings.top` — bounded (≤3) UI-ready top findings
  (severity, code, message, path, line, freshness) published by the
  coordinator; extended `AiraIntelligenceHandle` with `subscribe()` and
  `relevantSymbols()`; repository provider gains `workingSet()` and
  `relevantSymbols()` (cached-index derived, zero scans, zero git).
- `AgentSession.airaIntelligence` getter (mirrors the other handles).
- Workbench settings group (`workbench.enabled|showOnStartup|density|width`)
  with clamped getter/setter in the canonical settings store.
- Theme schema: eight optional semantic color roles with classic fallbacks.

### 3.2 UI ownership + projection rule

`WorkbenchController` (interactive mode only) is the ONE native Workbench UI
owner. It holds presentation state only: explicit visibility choice,
renderer bindings, cached seam inputs. All subsystem truth stays in
`AiraSessionState`; `projectWorkbench(state, …)` is a pure function (no
business logic, no mutation). Rendering is token-free by construction:
every panel/footer value derives from canonical snapshots plus the two
bounded seam inputs (working set, symbols). ADR-031.

### 3.3 Snapshot/subscription model

- Controllers subscribe to the canonical manager seams:
  intelligence, execution, browser, verification, orchestration, goal,
  interaction, permissions, tasks — plus the session agent-event stream
  (0 model calls; all handlers repaint only).
- Working-set/symbols refresh is coalesced (400 ms debounce, versioned,
  serialized) and triggered only when `repository.changeCount` changes or
  agent events land; git processes never run at render frequency.
- Updates are event-driven: a panel repaints when its source snapshot
  changes; streaming conversation ticks do not re-run projections (they
  only invalidate the renderer).

### 3.4 Renderer integration

- **Fullscreen** (TuiAltScreen): the layout root becomes
  `VStack[ HStack[ main, sidebar ], footer ]` where the sidebar entry is a
  ScrollView (`follow: none`, `overscroll: contain`, auto scrollbar) with a
  `visible(viewport)` callback — native responsive hiding, independent wheel
  scrolling (wheel over the sidebar scrolls the sidebar; keyboard
  page-up/down stays on the primary transcript scrollview).
- **Regular** (TuiMainScreen): `AiraTuiMainScreen` shrinks non-footer child
  widths by the rail width; the rail itself is a real overlay entry
  (top-right, nonCapturing, `maxHeight: "100%"`, `visible` callback keeps
  width synced) — viewport-fixed, repainted every frame, never takes focus,
  conversation text never hides under it; the footer renders full-width.
- **Footer**: single-line segment rail (mode first, model last) with
  left/right zones; extension statuses keep their own line when present
  (extension contract preserved).
- Scroll behavior is documented: fullscreen has independent scrolling;
  regular mode has a viewport-fixed rail with priority-based panel dropping.
- The workbench overlay is detached before renderer switches and re-bound
  after mount (`switchTuiMode`), so `regular ↔ fullscreen` keeps working.

### 3.5 Cleanup / headless boundary

- `dispose()` unsubscribes every canonical listener, clears the coalesce
  timer, and detaches the renderer bindings; `stop()` and
  session-invalidate/re-bind paths both dispose/recreate the controller.
- Headless boundary (hard): `src/aira/ui/*` contains no TUI imports (test
  `headless.test.ts` asserts the module graph); `WorkbenchController` and
  the renderer live under `modes/interactive/workbench/` and are only ever
  constructed by `InteractiveMode` (print/SDK/RPC never instantiate them).

## 4. Responsive behavior

- **Wide** (≥ 118 cols): full adaptive Workbench (all relevant panels).
- **Medium** (≥ 106 cols, below 118): sidebar visible when the safe minimum
  allows; P3 panels hidden (`mediumHidden`), changeset capped.
- **Narrow** (< safe minimum `72 + sidebarWidth`, default 114): sidebar
  auto-hidden regardless of user choice; footer drops low-priority segments
  first (drop ranks: git Δ 1, permission 2, LSP 4, active-work 10, cwd 40,
  finding 60, interaction 100, mode/context/model never dropped).
- Restore semantics are deterministic (`visibility.ts`): default restores
  after widening; explicit OFF stays off; explicit ON restores. Resize
  itself re-evaluates through `visible()`/`visibleAt()` — no layout rebuild
  on resize (only on toggle/settings change).
- The `Ctrl+Shift+O` toggle is session-scoped state (`explicitVisible` tri-state);
  `/workbench [on|off]` mirrors it.

## 5. Panels

| Panel | Visibility rule | Canonical source | Update |
| --- | --- | --- | --- |
| Interaction (Question/Permission) | pending interaction only | `state.interaction` | subscription |
| Current Finding | a meaningful arbitrated finding exists | arbitration across `state.*` | subscription |
| Verification | status != idle or result exists | `state.verification` | subscription |
| Goal | `goal.status != idle` | `state.goal` | subscription |
| Tasks | canonical task rows exist | `state.tasks` | subscription |
| Agents | running/queued children or failures exist | `state.orchestration` | subscription |
| Execution | running process, failed settled process, or recent result | `state.execution` | subscription (events) |
| Browser | active/degraded/tabs/check/console evidence | `state.browser` | subscription |
| Working Set | changed files (bounded 8) | canonical `workingSet()` seam (git) | coalesced refresh |
| Relevant Symbols | index has symbols in the working set | `relevantSymbols()` (cached index) | coalesced refresh |
| Changeset | changed files (bounded +/-) | same working-set seam | coalesced refresh |
| Intelligence | snapshot exists | `state.intelligence` | subscription |
| Control/Permissions | snapshot exists; P3, hidden in medium | `state.permissions` | subscription |

Each panel is bounded (≤ 8 rows), priority-ordered (P0 → P3, stable panel
order), and derived from ONE canonical snapshot per the panel table.

## 6. Footer

Segments (display order): mode (required) · interaction ASK (required) ·
finding · LSP · verification · browser · agents · goal · execution ·
permission · [gap] · cwd (branch) · git Δ · context (required) · model
(required). Drop ranks are explicit; required segments only compact/truncate.

Highest-priority finding arbitration (`finding.ts`): deterministic source
order within explicit priority classes, severity always taken from the
canonical source (verifier verdict, finding severity, interaction type,
browser check status, execution ok, orchestration failure category, goal
waiting kind). Compact footer form: `TS2339 · Surface.replaceWith missing`,
`VERIFY ✕ · …`, `WAIT · user decision required`.

Context usage (percent/window + auto) and model (+thinking) are always
preserved; per-segment compact variants kick in before dropping.

## 7. Input / keybindings

- `app.workbench.toggle` — default `ctrl+shift+o` (`Ctrl+Shift+O`).
- `app.tools.expand` — default `ctrl+o` (`Ctrl+O`, preserved).
- `app.tree.filter.cycleForward/Backward` — unchanged (`ctrl+o` /
  `shift+ctrl+o`, context-scoped to the tree selector).
- Conflict policy (truthful): user customizations are never overwritten
  (user bindings override defaults in `KeybindingsManager`); `/doctor`
  reports `workbench shortcut` (`ctrl+shift+o`) and preserved expansion
  (`ctrl+o`). Documented in
  `packages/coding-agent/docs/keybindings.md`.
- Focus/scroll: the sidebar never takes focus (nonCapturing overlay /
  non-primary ScrollView); conversation scroll keys stay on the primary
  scrollview; wheel inside the fullscreen sidebar scrolls it independently.

## 8. Tokens / performance

- Rendering is provably token-free: projections consume only canonical
  snapshots + cached seam inputs; no provider/model code runs (doctor
  reports subscriptions; the headless test asserts the module graph).
- Update strategy: event-driven subscriptions + coalesced git seam; no
  polling; no per-frame LSP/browser/git queries; resize costs one layout
  pass through `visible()` callbacks; toggles rebuild only the layout root.
- Streaming behavior observed in dogfood: a 500-line stream with a running
  dev process + goal + agents kept the UI responsive with stable panels (no
  redraw storm; sidebar repaints only on canonical changes).

## 9. Dogfood (native Aira binary, no Pi Atelier)

All runs: `HOME=/tmp/aira-dogfood-home` (copy of the real `~/.aira/agent`
minus `theme`, so the DEFAULT theme path applies), built bundle
`packages/coding-agent/dist/bundle/cli.js`, tmux 142×40.

- **CASE 1 Default (wide)**: Workbench visible on startup; `aira-zhr` active
  (unset theme → aira-zhr on dark; /doctor `aira-zhr theme: resolved`);
  footer `◈ BUILD │ LSP TS │ PERM normal · cwd (master) · ctx · model`.
- **CASE 2 Toggle**: two `Ctrl+Shift+O` presses hide + restore the sidebar, no
  state loss. `/workbench off|on` works.
- **CASE 3 Narrow/Medium**: at 90 cols the sidebar is auto-hidden and the
  footer keeps mode/context/model (drops opportunistic segments); at 116
  cols the sidebar renders narrower with the P3 Control panel dropped
  (medium layout). Live terminal resize is blocked by a PRE-EXISTING crash
  (see §11) — policy restore semantics are covered by unit tests.
- **CASE 4 Explicit off**: toggled off stays off (deterministic rule +
  unit tests; live resize blocked by the pre-existing issue).
- **CASE 5 LSP finding**: the deterministic projection path is unit-tested
  (`TS2339 · Surface.replaceWith missing` → footer). The live
  typescript-language-server stayed `idle` on this machine (never published
  diagnostics; see §11), so the end-to-end live finding was exercised via
  the equivalent canonical sources (verifier FAIL, browser console error,
  execution failure) through the same arbitration.
- **CASE 6 Execution**: `process_start` background `node -e 'process.exit(3)'`
  → panel shows `✕ node -e 'process.exit(3)' code 3` (dogfood found that
  backgrounded exits push no recent result — fixed in panels). Dev process
  (`python3 -m http.server`) shows as live `dev · …` with `RUN 1` in the
  footer; `✓ node --test` shows green; `EXEC ✓/✕` segments work.
- **CASE 7 Browser**: `browser_open` on a file with a console error →
  panel `Status active · available`, `Page`, `Console 1E 0W` (red), `Network
  clean`, `View`, `Dev dev-2 (running)`; footer `BROWSER ●`/`BROWSER ✕1`.
- **CASE 8 Verification**: auto verifier at the completion boundary →
  `Verdict FAIL · fresh` (red, prominent, 3/4 requirements, missing
  evidence); after later edits `FAIL · stale` (honest staleness); PASS
  stays compact (`VERIFY ✓`).
- **CASE 9 Goal**: auto goal (smart) + explicit `/goal create` → GOAL panel
  (State, Objective, Tasks 2/2 from delegated children, Verify
  inconclusive, Budget, progress bar), footer `GOAL R1 2/2`; waiting
  evidence/input states raise to P0 Current Finding; `/goal stop|clear`
  update the panel instantly.
- **CASE 10 Tasks/Agents**: `agents_delegate` batch of two explore children
  → distinct Tasks and Agents panels with truthful running/queued rows, footer
  `AGENTS 0` after settling; goal task projection `2/2`.
- **CASE 11 Permission**: browser_open ASK naturally → Permission panel
  at the TOP (P0), Current Finding `authorization: Allow browser_open to
  run?`, footer `ASK ● Allow browser_open to run?`; answering updates state
  immediately (panel disappears).
- **CASE 12 Q&A**: `ask_user` → Question panel (Prompt, Choices 3, waiting
  duration), P0 finding; answering removes the projection.
- **CASE 13 Performance**: 500-line stream while dev process ran + goal
  active + agents settled: UI responsive, panels stable, no flicker, no
  token overhead (rendering is snapshot-only).
- **CASE 14 Headless**: `-p` runs (`aira-wb-ok`, `4`), `--list-models`,
  full non-e2e suites green; Workbench never instantiates outside
  interactive mode (module-graph test).

## 10. Verification

- New focused tests (packages/coding-agent/test/aira/):
  `ui/projection.test.ts` (23: visibility policy, finding arbitration,
  panel priority/visibility, working set/changeset, footer arbitration +
  truncation + required segments, background-process execution panel,
  medium dropping), `ui/theme.test.ts` (aira-zhr built-in + semantic
  mapping + classic fallbacks + default resolution), `ui/headless.test.ts`
  (module boundary), `workbench-keybindings.test.ts` (Ctrl+Shift+O toggle,
  Ctrl+O preservation, user override, tree-filter untouched, conflict-free
  defaults).
- Updated: `commands/doctor.test.ts` (18 checks incl. workbench shortcut +
  aira-zhr theme), intelligence/verification fixtures (`findings.top`).
- Suites: `test/aira/**` 620 tests green; the two Phase 12-touched legacy suites
  (`footer-width`, `startup-session-rebind-duplicate-subscription`) green;
  full `./test.sh` runs the repo suites; `npm run check` (biome, pinned deps,
  ts-imports, shrinkwrap, install-lock, tsgo, browser-smoke) green before
  every commit.
- Pre-existing unrelated failures (VERIFIED against the Phase 11 baseline
  worktree at `3bdb2f50f`, regenerated model data present, same Node): the
  agent-session/model-catalog cluster (~30 tests: `agent-session-*`,
  `test-harness`, `lax-message-content`, regressions 1717/2023/5943/5998/
  6162/6363/8261, `fireworks-models`, `zai-coding-plan-models`) fails
  identically on the baseline — an environment/Node-25 timing drift in the
  agent-loop suite, NOT a Phase 12 regression. Phase 12 introduced exactly
  two regressions during development — the footer telemetry rewrite and a
  rebind hook — both fixed and covered by tests before this report.

## 11. Environment findings (pre-existing, NOT Phase 12 regressions)

1. **Terminal resize kills the Pi TUI on this machine** (tmux and macOS
   Terminal.app; Node 22.23.2 and 25.9.0): the process exits silently on any
   SIGWINCH resize. Reproduced with the Phase 11 baseline binary built from
   `3bdb2f50f` — identical behavior. Phase 12 resize dogfood therefore used
   sessions started at the target widths; the responsive rules themselves
   are width-pure and unit-tested. Worth a follow-up issue upstream
   (suggested: Pi compat hardening phase).
2. **Live LSP stayed `idle`** on this machine: `typescript-language-server`
   spawns but never publishes diagnostics (tsc confirms the errors; the
   verifier's language evidence also read 0 diagnostics). Phase 5 behavior,
   out of Phase 12 scope; the finding pipeline is covered by deterministic
   tests and exercised live through verifier/browser/execution sources.
3. tmux's `extended-keys` warning is pre-existing guidance (Pi recommends
   enabling it; unrelated to the crash).

## 12. ADRs (see DECISIONS.md)

- ADR-031 — Aira owns one native Workbench; UI only projects (no second
  state owner, no TUI in headless).
- ADR-032 — Responsive sidebar policy + semantic Workbench binding (auto-hide
  below the safe minimum; explicit off respected; Ctrl+O expansion preserved).
- ADR-033 — Footer priority system + highest-priority finding arbitration.
- ADR-034 — Theme semantic contract: eight optional roles with classic
  fallbacks; `aira-zhr` is the default dark theme.
- ADR-035 — Extension chrome conflicts are diagnosed truthfully (`/doctor`),
  never fought over.

## 13. Every local Git commit (this phase)

1. `57cd379bb` docs(aira): baseline aira-zhr workbench mockup (rename + theme)
   — the pre-existing uncommitted rename, committed as Phase 12 baseline prep
   (user-approved).
2. `00b28a55d` feat(aira): native Workbench — aira-zhr theme, projection
   layer, sidebar, footer rail, Ctrl+O toggle.
3. `80c40f7b4` fix(aira): dogfood findings — execution panel shows failed
   background processes, context suffix, cleanup.
4. `3aaf9953f` docs(aira): Phase 12 report, ADR-031..035,
   roadmap/architecture/backlog/changelog; restore footer telemetry as
   usage segment; rebind hook fix (footer-width + rebind regression tests
   restored to green).
5. `e1605def7` fix(aira): regular-mode rail never paints over the footer
   (short-document geometry — final dogfood capture found the rail
   covering the floating footer; fixed via footer-start-row tracking).
6. `d8d09d000` fix(coding-agent): visual-parity polish, truthful task/agent and
   intelligence projections, native footer arbitration, semantic shortcut
   preservation, renderer invariants, and regression coverage.

## 14. Visual-parity polish follow-up (2026-09-01)

### 14.1 Gap audit

The approved HTML composes a dominant conversation pane and a quieter
engineering pane with a continuous edge, compact section rhythm, fixed label
columns, right-aligned metadata, progressive disclosure, and a footer split
into operational state (left) and session telemetry (right). The first native
implementation had the correct architecture and data, but several renderer
details still read as plain status text: its pane edge ended with content,
10-cell labels could collide (`Permissionnormal`), trailing values did not
align, detail rows were not counted by height fitting, TASKS and AGENTS shared
one ambiguous panel, cold intelligence could show `uninitialized`, and the
native footer did not call its own drop arbitration.

### 14.2 Implementation decisions

- The regular-mode rail now paints one continuous muted `│` edge down to the
  footer. Fullscreen keeps content-height rendering inside its independent
  ScrollView instead of allocating an artificial 10,000-line surface.
- `AIRA` uses copper and `WORKBENCH` uses primary text. Section titles are
  restrained primary text; semantic state colors remain canonical.
- Rows have a responsive label column with a guaranteed gap, right-aligned
  trailing metadata, ANSI-aware truncation, stable output width, indented
  bounded details, and accurate height accounting.
- Intelligence suppresses a cold `uninitialized`/`unavailable` snapshot,
  reports `clean` only when the canonical change seam says zero changes, and
  shows at most three diagnostic locations/messages with explicit non-fresh
  status. Stale or indeterminate errors never render as current errors.
- TASKS projects `state.tasks`; AGENTS separately projects canonical child
  lifecycle (`running`, `queued`, failure). Footer counts use `running+queued`
  notation instead of an ambiguous active total.
- Pending semantic questions and permission asks remain secondary projections
  of the Phase 11 interaction owner. The sidebar is never required to answer.
- Native footer rendering now applies the same drop-rank arbitration as the
  headless projection. Narrow mode drops permission/git/detail before the
  required mode/context/model segments.
- The default composer border uses aira-zhr copper when thinking is off;
  existing thinking/bash semantic border states remain authoritative.
- `app.workbench.toggle` is `Ctrl+Shift+O`; `app.tools.expand` remains
  `Ctrl+O`. Tree bindings remain context-scoped and unchanged.

### 14.3 Pi Atelier follow-up findings

- **ADOPT:** ANSI-aware width padding/truncation and full-height dock edge.
- **ADAPT:** height-aware panel fitting now counts secondary detail rows;
  native Aira keeps its flat HTML-derived hierarchy rather than Atelier cards.
- **ADAPT:** footer priorities are applied at the final native composition
  boundary, not only in a parallel projection used by tests.
- **REJECT:** draggable resize, animated jewels, boxed crowns, contributed
  panels, prototype adapters, and Atelier visual identity remain out of scope.

### 14.4 Responsive and performance verification

Built-native captures were inspected at 142×40 and 90×28. Wide mode keeps a
42-column Workbench with a continuous edge and aligned rows; narrow mode hides
the Workbench and preserves transcript/editor width. The existing live-resize
SIGWINCH limitation remains external to this pass, so widths were launched as
separate sessions. Rendering remains event-driven and token-free: no new scan,
Git, LSP, browser, provider, model, timer, or polling path was added.

The HTML target's CSS backgrounds, rounded cards, proportional grid, mouse
hover/focus effects, and pixel spacing cannot be reproduced faithfully in a
cell terminal. The native equivalent uses color, edge continuity, whitespace,
alignment, and bounded disclosure. The in-app browser also blocks local
`file://` rendering by policy, so the HTML comparison used its checked-in
HTML/CSS source; native comparison used actual tmux captures.

Focused coverage now includes idle sparse state, goal progress, distinct
running/queued agents, execution, browser, verifier, interaction/permission,
fresh and non-fresh LSP findings, responsive visibility, native footer drops,
renderer width/label/detail invariants, semantic keybindings, headless
isolation, and missing optional state. The final focused run passed 70 tests
across eight files, and `npm run check` passed. The coding-agent package build
also passed. The root build could not refresh the generated model catalog
because this sandbox could not resolve `models.dev`; no generated file changed.
The full `./test.sh` run continued across all workspaces but was not green:
network and Unix-listener suites failed with sandbox `listen EPERM` errors and
related timeouts. These failures are outside the Workbench paths; the focused
regression set above remained green after that run.

## 15. Stopping point

Phase 12 is complete. Next roadmap phase per the renumbered table:
**Phase 13 — Policy, Hooks, and Trust** (unchanged scope, renumbered).
No work beyond Phase 12 was started; nothing was pushed or published.
