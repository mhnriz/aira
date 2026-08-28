# Phase 7 — Native Browser Runtime: Report

> Status: complete (2026-08-28) | Commits listed at the end are part of this
> phase. Scope honored per the phase brief: one native browser subsystem with
> a replaceable provider boundary, isolated default profile, bounded evidence,
> ambient-context policy, and UI-ready snapshot state. No Phase 8 verifier,
> no Workbench UI overhaul, no engineering-loop, no personal-browser mode.

## Reference study

### Installed paths inspected (READ-ONLY)

Reference implementations were located under the Aira install's user package
tree (not `~/.pi` — discovered by inspection):

```text
~/.aira/agent/npm/node_modules/betterwright/          v1.10.2
├── README.md SETUP.md SECURITY.md NOTICE.md LICENSE  provenance + policy docs
├── docs/architecture.md browser-providers.md network-policy.md sessions.md …
└── dist/src/{worker,daemon,client,session-store,snapshot,pi-extension,
              browser-runtime,browser-providers,network-policy,policy,
              chromium-fork,profile-lock,guard-proxy,vault,…}.js
~/.aira/agent/npm/node_modules/pi-browser-harness/    v0.11.0  (MIT)
├── README.md LICENSE
└── src/cdp/{session,discovery,ownership,console-buffer,network-buffer,
              record-store,commands,events,types}.ts
    src/domains/{ax-tree,snapshot,ref-resolve,click,fill-engine,keyboard,
                 navigate,network,console,js,screenshot-capture,box,…}.ts
    src/profile/{launch,paths,bind,store}.ts  src/daemon/*  src/registry.ts
```

Both were also exercised at runtime in stock Pi sessions (tool registration,
CLI/skills metadata) and their design read in full; no sources were modified.

### betterwright architecture findings

- Client/worker split over JSON-lines stdio; the worker owns a Playwright
  browser in a separate process — the process boundary is the trust boundary.
- Per-(home, profile) session daemon over a unix socket: persistent browser,
  named sessions with TTL idle-out, replay buffers for dropped connections,
  orphan-grace interruption, elided on-disk transcripts (O(actions), not
  O(observations) — deliberate prompt-cache shape).
- Security floors: mandatory loopback SOCKS transport proxy re-authorizing
  every resolved IP (DNS-rebinding defense), fail-closed NetworkPolicy,
  WebRTC pinned to the proxy, vault outside the Chromium profile,
  node:vm sandbox explicitly NOT claimed as a boundary.
- Token efficiency: compressed a11y snapshots (`ariaSnapshot({mode:"ai"})`
  + pruning), `filterInteractive` refs, proof screenshots, evidence
  checklists, bounded step budgets.
- Provider abstraction (`browser-providers.js`): managed BetterChromium
  fork default, caller-supplied binaries and CDP endpoints as opt-in.

### pi-browser-harness architecture findings

- Attaches to the USER'S RUNNING Chrome over CDP (`DevToolsActivePort`
  discovery, `-9222` fallback, env overrides); dedicated window per session;
  ownership registry tracks targets the harness created; refuses tabs it
  did not open.
- `Accessibility.getFullAXTree` → slim tree (`interestingOnly`, node
  budget), stable `eN` refs keyed to backend node ids, re-resolved at
  action time; signatures for staleness; interactive-diff after mutations.
- Compositor-level `Input.dispatchMouseEvent` clicks; framework-safe fill
  engine (native prototype value setter + bubbling input/change) executed
  via `Runtime.callFunctionOn`; per-tab bounded console/network ring
  buffers with dedupe and cursors; dialogs tracked; screenshots to
  managed temp paths.

### Classification (native / adapt / defer / reject)

1. **IMPLEMENT NATIVELY IN AIRA** — isolated-browser launch + ownership,
   CDP wire mechanics (attach, domains, AX-tree refs, compositor input,
   fill engine, console/network buffers — Aira-native implementations,
   no copied sources), semantic observation as first-class evidence,
   bounded evidence model, ambient eligibility/context, canonical
   snapshot, PLAN semantics via the capability table, `/browser`,
   `/doctor`, `/status`, canonical settings.
2. **ADAPT BEHIND A PROVIDER BOUNDARY** — the idea of a
   launch-vs-connect provider abstraction; persistable sessions are
   expressed as Aira session lifecycle instead of a daemon.
3. **DEFER** — credential vault, captcha solving, web search,
   live-view/handoff, stealth/fingerprinting, network guard proxy,
   cloud providers, downloads, transcript store, evidence checklists
   (Phase 8 territory).
4. **REJECT** — attach-to-personal-Chrome as the default (safety),
   Playwright as a runtime dependency, daemon/socket persistence,
   the extension-based registration model, ~/.pi or ~/.aira-extension
   dependencies at runtime.

### Source/license provenance

No source was copied or substantially adapted. The native CDP
implementation is original work informed by protocol-level study of the
references (both MIT-licensed; betterwright LICENSE/NOTICE reviewed — its
dist code is not included). pi-browser-harness LICENSE: MIT. betterwright
LICENSE: MIT (NOTICE file reviewed). No third-party notices are required
in Aira sources because nothing was copied.

## Architecture

### Modules introduced (`src/aira/browser/`)

```text
src/aira/browser/
├── manager.ts            AiraBrowserManager — the runtime owner (per session)
├── provider.ts           AiraBrowserProvider — the replaceable boundary
├── settings.ts           canonical browser settings + defaults/normalization
├── status.ts             AiraBrowserStatus — bounded canonical snapshot
├── types.ts              session/tab records, evidence, operation results
├── context.ts            ambient context pack (hard budgets, dedupe hashes)
├── eligibility.ts        availability ≠ eligibility ≠ activation rules
├── url-discovery.ts      local URL from Phase 6 dev output / conventions
├── tools.ts              15 model-facing browser tools (sequential)
└── cdp/
    ├── client.ts         zero-dependency CDP client (native WebSocket)
    ├── launch.ts         Chromium discovery + isolated launch (port 0)
    ├── session.ts        per-tab attach, domain enable, event routing,
    │                     ref maps + main-frame navigation invalidation
    ├── observe.ts        AX tree → bounded semantic observation + refs
    ├── interact.ts       click/fill/press/scroll/evaluate/wait + staleness
    ├── console.ts        bounded console evidence (dedupe, counts)
    ├── network.ts        bounded network failure evidence (dedupe, counts)
    ├── screenshot.ts     Page.captureScreenshot → managed paths (in provider)
    └── provider.ts       CdpBrowserProvider implementation
```

### Runtime owner and provider choice

One `AiraBrowserManager` per `AgentSession` instance (ADR-025) — created at
session construction (lazy, probes availability only), disposed with the
session. The provider is the native CDP/Chromium provider: **zero new npm
dependencies** (Node >= 22.19 native WebSocket), Chrome discovered from
`AIRA_BROWSER_EXECUTABLE` → platform candidates → PATH, launched headless
with `--remote-debugging-port=0`, endpoint read from the profile's
`DevToolsActivePort`, and killed only through Aira-owned handles (pid also
tracked in the host's detached-child registry for crash paths).

### Profile strategy / ownership model

Fresh disposable profile per session under
`~/.aira/agent/cache/browser/session-<id>/`, wiped before launch and
removed on close. Sessions/tabs carry `ownerSessionId`; disposal kills only
Aira's own browser; overlapping sessions can never close each other's
browsers (ADR-018/ADR-024 pattern). Tabs opened by the page
(`Target.targetCreated` with an owned opener) are adopted.

### Observation model and element refs

First-class evidence is the bounded accessibility-tree observation: title,
URL, readyState, one-line summary (headings/controls/links/dialogs counts),
outline capped by a char budget with an explicit truncation marker, and
interactive targets with stable `eN` refs (backend node ids) plus viewport
coordinates. Ref lifetime semantics: refs are invalidated on main-frame
navigation; at action time each ref is re-verified against the live
document (URL equality, element connectedness); stale refs fail truthfully
and never silently target a different element. DOM dumps never enter state
or context; node budgets (400) and char budgets (4000) bound the outline.

### Interaction surface

Fifteen coherent tools (not dozens): browser_open, browser_status,
browser_observe, browser_navigate, browser_click, browser_fill (inputs/
textarea/contenteditable/select/checkbox/radio), browser_press,
browser_scroll, browser_wait (selector/text/url/ready/time), browser_evaluate,
browser_console, browser_network, browser_screenshot, browser_verify,
browser_close. All tools declare `executionMode: "sequential"` (the agent
runs parallel tool calls otherwise — a real race found and fixed during
dogfood). Operations return structured results: ok/operation/target/reason/
fresh tab state/console+network counts/page-change diff.

### Console / network capture

Bounded per-tab rings with deduplication (counts on first record):
console errors/warnings/info/log with source+line (Runtime.consoleAPICalled
+ Log.entryAdded); network failures only (loadingFailed + 4xx/5xx,
cosmetic subresource noise excluded). Summaries always carry
`{errors, warnings, total, topFinding}` / `{failures, topFinding}` — the
same shape feeds both model context and the future UI.

### Screenshots / timeout / cancellation / cleanup / cross-platform

Screenshots: `Page.captureScreenshot` → `cache/browser/screenshots/`,
last-8 pruning, metadata-only in state. Timeouts: navigation 30s default,
per-command CDP timeouts, wait/verify bounds; operations carry truthful
`reason` strings. Cancellation: AbortSignal flows for waits/verifies.
Cleanup: dispose kills the browser process (graceful → forced), removes the
profile, clears listeners; host crash paths reap the tracked pid; unrelated
user browsers are never touched. Cross-platform: launch candidates for
macOS/Windows/Linux, taskkill tree on win32, `--no-sandbox` only when
root, `--disable-dev-shm-usage` on Linux; a missing browser is
`unavailable`, and Aira installs and runs regardless (documented in
ROADMAP/ADR-025). Headless-only in Phase 7; `AIRA_BROWSER_EXECUTABLE`
overrides discovery.

### Capability semantics / graceful degradation

Every `browser_*` tool classifies `browser` with a semantic operation kind
(observe | navigate | interact | lifecycle) — table-driven (capabilities.ts),
no name heuristics. PLAN: observation + navigation available; interaction/
evaluation/verification/lifecycle blocked by the existing gate and hidden
from the model. `browser.enabled=false`, missing executables, launch
failures, crashes (browser-exit → `degraded`), navigation timeouts, stale
refs, and dev-server disappearance all degrade truthfully; a browser
failure never breaks normal coding.

## Ambient context

- `browser.context=off` — no automatic injection ever; explicit operations
  still return results; snapshot stays UI-visible.
- `browser.context=auto` (default) — injects only on SIGNAL: pending
  browser-relevant edit, verification result change, or active-tab URL
  change since the last injection. README edits, backend-only changes, git
  work, unrelated planning → zero browser tokens (tested CASE A/B; the pack
  is injected once after open/navigate to carry fresh page state, then
  deduped).
- `browser.context=on` — injects whenever an active session has fresh
  evidence, still hard-budgeted and hash-deduped.
- Budgets: compact ≤ 600 chars (default), balanced ≤ 1200, expanded ≤ 2400;
  unchanged content (content-hash) is never re-injected; the pack shape is
  the brief's example (Browser / URL summary / check / console counts +
  top finding / network line).
- Future Context Broker seam: context.ts is a pure selector of
  subsystem state; hashing and budgets are per-provider today, but the
  snapshot shapes and content hashes are broker-ready. Consolidation is
  documented as deferred (no generic broker built).

## Settings

Canonical store only (host `SettingsManager` → `settings.json`,
`/settings` surface): `browser.enabled` (default true when available),
`browser.context` (off|auto|on, default auto), `browser.autoVerify`
(default true, strictly gated: relevant edit + running dev process +
output-derived URL + BUILD + debounce/min-gap; exactly one pass),
`browser.contextBudget` (compact|balanced|expanded, default compact).
No other knobs (no console/network evidence granularity settings — the
budget covers them; no headed option — headless-only documented).

## Modes

- BUILD: full browser surface; auto-verify allowed.
- PLAN: observation + navigation + evidence inspection + screenshots
  available; open/close/click/fill/press/evaluate/verify blocked at the
  boundary (gate) and hidden (availability set). Verified in tests and in
  the real TUI dogfood (`browser_open → tool unavailable`,
  `browser_wait → browser is not open`).
- REVIEW: observation emphasized; `browser_verify` provides the bounded
  changed-flow evidence; REVIEW is not the Phase 8 verifier.

## UI-ready state

`state.browser` (AiraBrowserStatus — bounded, serializable,
provider-independent, TUI-independent): availability, eligibility, status
(idle|active|degraded|unavailable), provider, profileKind (isolated),
profileDir, tabs, activeTab (id/url/title/readyState), console
{errors,warnings,total,topFinding}, network {failures,topFinding},
observation {revision,summary,nodeCount,lastAt}, verification
{status,lastCheckAt,finding}, screenshot {lastPath,lastAt},
devProcess {id,status,url}, reason, updatedAt. Updates flow through the
manager's explicit publish (constructor, each operation, dispose) with a
`subscribe()` listener seam. Rendering the future footer/Workbench line
(`Browser ● ready · 1E · check ✕`) requires zero provider calls, zero
model tokens, and browser.context=off does not hide it (tested).

## Other surfaces

`/browser` (new unnamespaced command) renders the canonical snapshot;
`/status` adds a restrained `browser: idle | active (url)` line; `/doctor`
gains check #10 (browser: truthful availability/status/counts; absent
browser is `unavailable`, not a failure; currently 10/10); `/settings`
gains the Aira Browser submenu (enabled/context/auto-verify/budget) through
the existing selector; SDK/headless sessions get the browser tools by
default (extended default active tool set); `/processes` unchanged.

## Testing

### Tests added (`test/aira/browser/`)

- settings.test.ts — defaults, normalization, SettingsManager round-trip (4).
- url-discovery.test.ts — dev-output parsing, conventions, loopback safety,
  honest none states (8).
- eligibility.test.ts — profile/change/dev/mode/PLAN/REVIEW rules + path
  classification (9).
- context.test.ts — full token-budget contract: CASE A (auto, no signal →
  zero), A2 (no active session → zero), B (dedupe by hash), C (off → state
  visible, no context), D/D2 (on/auto with actionable error+verification →
  bounded evidence), E (hard budgets per class) (8).
- buffers.test.ts — console/network dedupe, counts, top findings, caps,
  cursors, 4xx/5xx, cosmetic-noise exclusions (8).
- observe.test.ts — AX slimming, ref assignment, budgets, truncation
  markers, summaries (5).
- manager.test.ts — 18 fake-provider lifecycle tests: idle snapshot, no
  launch on arm, unavailable truthfulness, open/observe revision,
  typed not-open errors, disabled setting, close, crash-degraded, CASE A/B
  through the manager, auto-verify single pass + gates (dev server,
  autoVerify=false), backend-edit inertness, explicit verify + needs-url,
  screenshot reference, single dispose, listener seam.
- host-integration.test.ts — 6 real-AgentSession tests: default tool
  registration, model tool call open→observe with canonical snapshot,
  PLAN boundary/hiding, context=off through the prompt path, auto
  zero-token + signal injection, unavailable degradation with a working
  session.
- real-chrome.test.ts — 10 tests against the REAL native provider +
  deterministic localhost fixture (skipped truthfully when no browser):
  availability + isolated launch, semantic observation (title/summary/
  refs/coordinates), ref fill + click with live value + change diff,
  console error capture (exact message), network 404 capture, screenshot
  bytes, stale-ref truthfulness after navigation (incl. the backend-id
  reuse safety), navigation timeout, clean close (profile removed),
  manager end-to-end with real Chrome + context budget/dedupe.

Upper-suite updates: capabilities/modes/plan-readonly/doctor/intelligence
host-integration extended for the browser sets; regression 3592/5109
enumerations extended; harness gained `airaBrowserOptions`.

### Focused results

```text
vitest --run test/aira/browser   → 68 passed (includes 10 real-Chrome)
vitest --run test/aira            → 292 passed, 0 failed
vitest --run test/suite test/aira → 108 files, 553 passed, 0 failed
tsgo --noEmit (package)           → PASS
biome check (whole repo)          → clean (pre-commit gate)
npm run check (repo-wide)         → PASS on every Phase 7 commit
```

### Full-suite run

`./test.sh` (isolated HOME, no API keys) results:

```text
coding-agent    2268 passed / 50 skipped — 0 failed (Phase 6: 2255)
packages/ai     2 failed / 946 passed (pre-existing environmental only:
                fireworks-models Fire Pass turbo router, zai-coding-plan-
                models zero costs — machine-hydrated catalog pricing, zero
                Phase 7 diff in packages/ai)
agent · tui · client · evals · session-backends · scripts — all passed
```

One flaky-run observation, documented honestly: one full-suite run failed
the real-Chrome file with `CDP command timed out (Page.navigate)` while the
machine was heavily oversubscribed (a concurrent dogfood pty session, two
other suite runs, and CPU pumps from probes were all active). On a quiet
machine the full suite passes the real-Chrome file (verified run above);
the suite also passes it alongside several heavy parallel files
(co-run probe). The navigation CDP command carries a 30s bound; browser
tests remain skipped truthfully when no browser executable exists.

## Dogfood (real `aira` binary)

Rebuilt `packages/coding-agent/dist`, ran the real binary with an ISOLATED
agent dir (`AIRA_CODING_AGENT_DIR=/tmp/aira-p7-agent`, symlinked auth,
settings WITHOUT the reference packages — so the reference extensions
cannot load and every successful browser action proves the NATIVE path).

Fixture: `/tmp/aira-p7-dogfood` (git repo, `npm run dev` → node http app
on 127.0.0.1:0 printing its URL; counter button + name input + console-
error trigger + `/api/broken` 404).

- Phase 6 integration: model started `dev-1` (process_start,
  purpose dev), read `process_logs`, reported
  `http://127.0.0.1:58002` — URL discovery from managed-process output.
- Native browser flow (print mode): browser_open → browser_observe
  (heading/input/buttons, refs) → browser_fill "Aira" → click Increment
  ×2 → counter shows `count: 2` → Trigger error → browser_console reports
  exactly `DogfoodError: controlled boom` → browser_network reports
  `GET /api/broken — HTTP 404` → screenshot saved to
  `/tmp/aira-p7-agent/cache/browser/screenshots/aira-*.jpg`.
- Verify + close (print mode): browser_verify over the discovered URL →
  check failed truthfully (1E + 404 finding); browser_status showed
  `active · 1E 0W · 1 failed · check failed`; browser_close → idle.
- Interactive TUI: `/doctor` → `ok browser: available · idle · console
  0E 0W · network 0 failed`, `summary: 10/10 checks passed`; `/status`
  → `browser: idle`; `/processes` shows managed dev; **PLAN mode**
  (Shift+Tab): `browser_open → tool unavailable ("Tool browser_open not
  found")`, `browser_wait → "browser is not open (wait); call
  browser_open first"`; `/browser` renders the canonical snapshot with the
  isolated profile path; `/settings` → search "browser" proves the Aira
  Browser submenu ("Enable browser true · isolated Aira-owned profile").
- Cleanup: after `/quit`, zero Aira-owned Chrome processes, zero leftover
  dev servers, profile dir removed, screenshots dir retains the bounded
  capture. (Debug-test Chrome orphans found during development were
  cleaned; the product now registers every Aira-owned browser pid with the
  host's detached-child tracking — commit `5cfa9ff72`.)

## Compatibility

No extension API, slash-command, keybinding, or package surface was
removed; `/browser` follows the unnamespaced core-command convention
(ADR-017). The SDK default tool set gained the browser tools exactly like
the Phase 6 process tools. Unknown/third-party tools remain unclassified
(ADR-022). The `/settings` selector gained one submenu; nothing else in
the TUI surface changed. Aira continues to have zero dependency on
`~/.pi` and on the reference browser extensions.

## Architectural decisions

- **ADR-025 — Browser is a native Aira-owned runtime behind a replaceable
  provider boundary, with an isolated profile and strict state/context
  separation** (this phase; recorded in DECISIONS.md).

## Documentation updated

- `aira_product_docs/phases/PHASE_7_BROWSER_RUNTIME.md` (this report)
- `DECISIONS.md` (ADR-025)
- `AIRA_ARCHITECTURE.md` (browser section rewritten for the shipped
  subsystem + state/context rule + invariants)
- `ROADMAP.md` (phase table + browser row)
- `UI_BACKLOG.md` (B-00x: BrowserSnapshot projection, footer browser
  indicator, token-free state vs context rule)
- `CHANGELOG.md` (Feat entries under [Unreleased])
- `phases/README.md` (phase table row)

## Local Git commits created (nothing pushed)

```text
53d09d9f3 feat(aira): add native browser runtime with isolated Chromium provider
9ffe51e11 test(aira): cover the Phase 7 browser runtime through host and provider boundary
8e2ed2349 feat(aira): real-Chrome integration tests; ref staleness hardening across navigations
b95dada30 test(coding-agent): extend default-tools regressions for the native browser tools
5cfa9ff72 fix(aira): track Aira-owned browser pids for crash-path reaping
ab747beac fix(aira): longer navigation CDP bound; selector default; extend default-tools list
2a9bce705 docs(aira): Phase 7 report, ADR-025, changelog, architecture, roadmap, UI backlog
19e997eab docs(aira): record final full-suite results and load flake note in Phase 7 report
```

## Final `git status`

Working tree clean after the docs commit. `main` ahead of
`upstream/main` (baseline divergence, unchanged). Only remote: `upstream`
(Pi). No `origin`, nothing pushed, nothing published.

## Stopping point / next phase

Stopped after Phase 7 per roadmap discipline. Next: **Phase 8 —
Independent Verification** (the verifier consuming browser/session
evidence) and the Workbench/UI overhaul remain explicit architectural
targets; neither was started.