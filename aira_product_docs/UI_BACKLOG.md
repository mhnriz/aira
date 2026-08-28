# Aira UI Backlog

Future Aira UI-overhaul requirements. These are recorded product/design
intents; **none of them are implemented yet.** Each entry stays a backlog
item until its owning phase picks it up.

---

## B-001 — Ambient language-intelligence / LSP state in the native bottom bar

**Status:** backlog (future Aira UI overhaul; explicitly NOT part of Phase 6)

**Problem:** language-intelligence/LSP state is currently only visible
through `/doctor` or model-facing context. The user should be able to see,
at a glance, whether the language toolchain backing the current file is
cold, ready, or reporting findings — without running a slash command.

**Desired direction** (the eventual native bottom bar should surface
language-intelligence/LSP state ambiently):

```text
◈ BUILD  │  LSP TS ○          (cold/unprobed)
◈ BUILD  │  LSP TS ✓          (ready, clean)
◈ BUILD  │  LSP TS 2E 1W      (ready, findings: 2 errors, 1 warning)
```

When findings exist, also show a compact highest-priority/current finding
when terminal width allows:

```text
◈ BUILD │ LSP TS 2E 1W │ TS2304: Cannot find name 'handle'
```

Constraints:

- The UI must truncate intelligently and avoid becoming noisy.
- Multi-language projects should use a compact representation, for example:

```text
LSP TS ✓ · PY ✓
```

**Explicitly deferred:** this is a UI overhaul item only. Phase 6 (execution
runtime) must not implement any bottom-bar/footer redesign; the canonical
health state it builds on is `AiraSessionState.intelligence`
(`/doctor` reports it today).

---

## B-002 — Browser state in the native bottom bar and Engineering Context pane

**Status:** backlog (future Aira UI overhaul; NOT part of Phase 7)

**Problem:** browser runtime state is currently visible through `/browser`,
`/doctor`, `/status`, and model-facing context only. The future Workbench
should render it from canonical state with zero provider calls and zero
model tokens.

**Data contract already available (Phase 7):** `AiraSessionState.browser`
(`AiraBrowserStatus`) — availability (unknown/available/unavailable/
disabled), status (idle/active/degraded/unavailable), provider,
profileKind (isolated), activeTab (id/url/title/readyState), tabs,
console {errors, warnings, total, topFinding}, network {failures,
topFinding}, observation {revision, summary, nodeCount}, verification
{status, lastCheckAt, finding}, screenshot {lastPath}, devProcess
{id, status, url}, reason, updatedAt. Updated on explicit state
transitions; `manager.subscribe()` is the event seam.

**Desired projection — Engineering Context pane:**

```text
Browser
─────────────────────
Chrome        ● ready
Page          /player
Console       1E 2W
Network       1 failed
Check         ✕ failed

Current finding
TypeError: player.seek is not a function
src/player.ts:184
```

**Desired projection — bottom bar segment (compact):**

```text
◈ BUILD  │  LSP TS 2E 1W  │  Browser ● 1E  ·  Runtime ●  ·  Git +4 -1
```

with highest-priority actionable finding when width allows:

```text
Browser ● 1E · TypeError player.seek
```

**Projection rules:**

- The footer/Workbench derive from native subsystem snapshots
  (intelligence, browser, execution, git), never from polling provider
  internals.
- `browser.context=off` must NOT hide browser state from the UI: the
  snapshot is token-free and separate from model-context selection.
- Context deduplication must never delete UI-visible state.
- The browser indicator reflects `status` (idle/active/degraded) and the
  `console.errors + network.failures` counts; the finding line uses
  `console.topFinding` / `network.topFinding` / `verification.finding`.

**Explicitly deferred:** the full Workbench/UI overhaul remains a later
phase; Phase 7 implemented only the underlying snapshot/event seam,
settings, and commands.
