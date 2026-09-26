# Aira 0.2.0 — Pi 0.87.1 Upsync — Session Context (Archival)

Status: **Phase 4 in progress, paused at row 117** (two SKIP corrections awaiting approval).
Last verified state: `sync/pi-0.87.1` @ `12941ca33`, `main` @ `3c2eb7a67` (v0.1.9), worktree clean.

This document is an archival summary of the upsync session: mission, conventions,
decisions, commit mappings, the Aira-owned dogfood fix, operational lessons, and
the approved dispositions for the rows that have not been executed yet.

The **authoritative operational ledger** is:
`aira_product_docs/phases/PHASE_15_PI_0.87.1_UPSYNC.md` (rows 1–116 recorded).
Git history is authoritative for commit content, authorship and ordering. This
file is context, not a replacement for either.

All hashes below were resolved against the repository; none are transcribed from
compact renderings.

---

## 1. Mission and current state

| Item | Value |
|---|---|
| Repository | `/Users/hariz/proj/aira` |
| Protected baseline | Aira v0.1.9, `main` = `3c2eb7a67840c0bc80446781bf2549504ad8eb8c` |
| Safety ref | `backup/pre-pi-0.87.1-sync` = `3c2eb7a67` (created before any sync work) |
| Work branch | `sync/pi-0.87.1` |
| Branch HEAD | `12941ca331007a72f5745a92fca09848b317474e` (row-116 ledger commit; this file adds one docs commit) |
| Upstream range | `da840b621..d6af72e185` (260 commits) |
| Pi base | `da840b6216578c2a571d0374ac6a2091a83f9d91` — Pi 0.85.1 + `[Unreleased]` (tag `v0.85.1` = `d981de122`) |
| Pi target | `d6af72e185` — upstream/main, Pi 0.87.1 + unreleased commits (fetched 2026-09-25/26) |
| Release boundaries (row index = position in `git rev-list --reverse da840b621..d6af72e185`) | v0.86.0 = 163, v0.86.1 = 175, v0.87.0 = 193, v0.87.1 = 212 |
| Nothing pushed | true |

Row addressing: **row N = the Nth commit of**
`git rev-list --reverse da840b621..d6af72e185` (topological order, parents before
children). Never trust transcribed/compact-rendered hashes; always re-resolve.

Cumulative dispositions recorded through row 116:

- rows 1–33: DIRECT 10, REIMPLEMENT 4, SKIP 19 (33)
- rows 34–66: DIRECT 2, REIMPLEMENT 7, SKIP 24 (33)
- rows 67–99: DIRECT 3, REIMPLEMENT 6, SKIP 24 (33)
- rows 100–116: DIRECT 2, REIMPLEMENT 3, SKIP 12 (17)
- **rows 1–116: DIRECT 17, REIMPLEMENT 20, SKIP 79**

Phase 0 approved totals (all 260 rows, before execution corrections):
**DIRECT 42, REIMPLEMENT 69, SKIP 149.**

---

## 2. Upstream range and boundaries

| Version | Tag commit | Row index |
|---|---|---|
| Pi 0.84.3 (previous sync base) | `4e58f324f` | before range |
| Pi 0.85.1 (current Aira base) | `d981de122` | base commit is `da840b621` (one past the release) |
| Pi 0.86.0 | `ecac0a9c4` | 163 |
| Pi 0.86.1 | `13cbf77df` | 175 |
| Pi 0.87.0 | `16787ad5b` | 193 |
| Pi 0.87.1 | `f07218c4d` | 212 |
| upstream/main HEAD | `d6af72e185` | 260 |

The range contains 15 merge commits (ledger-only SKIP when their constituents
are accounted for), 4 upstream release commits, and two revert pairs
(rows 61↔64 DeepSeek test IDs; rows 66↔80 broken CI test).

---

## 3. Previous Pi 0.85.1 upsync — reconstructed convention

Reconstructed from git history, not memory:

- Shared history ends at Pi 0.84.3 (`4e58f324f`); `git merge-base main upstream/main` proves Aira never inherited upstream history after that point.
- Previous sync window: Aira v0.1.4 tip `c065fc1fb` → Aira v0.1.5 `bf61d7f36`; **502 upstream commits** audited (`4e58f324f..da840b621`), boundaries v0.84.4, v0.85.0, v0.85.1.
- Aira-side range `c065fc1fb..bf61d7f36` (92 first-parent commits): 46 direct copies, 14 reimplementations with `(upstream …)` markers, 31 Aira work commits, 1 release copy (`v0.84.4`).
- Mechanism: commits were **re-created on Aira's line** (no upstream merge/rebase). Reflog shows `commit:` for the copies; the pattern matches `git cherry-pick -n <sha>` + `git commit -C <sha>`.
- DIRECT convention (final Sep 6 batch — canonical):
  - upstream commit message **verbatim**, no added trailers;
  - upstream author name/email/author date preserved exactly;
  - Aira/Hariz is committer; committer date = application time;
  - new hash because the parent is Aira history.
  - Inconsistency to be aware of: some earlier copies preserved the upstream committer identity and set committer date = author date.
- REIMPLEMENT convention:
  - subject `type(scope): subject (upstream <short-sha>)` or `(upstream <short-sha> by <author>)`;
  - body line `Adapted from <Author>'s <full 40-char sha>, <upstream subject>.`;
  - upstream authorship preserved for near-faithful ports (e.g. previous commit `0bb06b350`).
- SKIP is recorded **only in the ledger**, with classes: `ALREADY_SATISFIED`, `SUPERSEDED_BY_AIRA`, `DESIGN_ONLY`, `MOVE_TO_LATER_PHASE`, `REJECTED`.
- Aira keeps its own `CHANGELOG.md` files; changelog-only conflicts are resolved in Aira's favor.
- Model catalogs: the generator (`packages/ai/scripts/generate-models.ts`, `generate-image-models.ts`) is the source of truth; provider data under `packages/ai/src/providers/data/` is gitignored and hydrated, never hand-edited.

---

## 4. Phase 0 / Phase 0B decisions

Phase 0 built the 260-row ledger (DIRECT 42 / REIMPLEMENT 69 / SKIP 149). Nine
rows were `NEEDS_DEEPER_REVIEW`; Phase 0B resolved them:

| Row | Upstream | Final | Reason summary |
|---|---|---|---|
| 9 | `caf6dfe7310c` | SKIP | native/prebuild clipboard refactor tied to Pi packaging; Aira keeps `@mariozechner/clipboard` + `clipboard-native.ts`. (Hash erratum: earlier rendering printed `5f1eef8a34`, which does not resolve.) |
| 97 | `9e05370b29` | SKIP | Pi `SystemMessage`/`TranscriptContext` architecture; Aira injects context as custom messages and rebuilds the leading system prompt per turn |
| 147 | `3c75b27479` | SKIP | bug reporting uploads to Pi's Radius gateway; product/backend decision |
| 188 | `466db0fecd` | REIMPLEMENT | canonical session context boundaries; **not** pico/durable — relevant to Aira Session/Branch/AgentLane; depends on row 97's model, so scope carefully |
| 224 | `002fc83852` | REIMPLEMENT | provider stream events to extensions (`onProviderStreamEvent` + `provider_stream_event`) |
| 226 | `a328aa89ad` | SKIP | image/classifier model-kind infrastructure; no Aira classifier consumer; would rewrite diverged model runtime |
| 231 | `a7d17e39aa` | SKIP | Jev classifier via OpenRouter/Cloudflare Workers AI; depends on 226; Pi-specific |
| 249 | `ca7460d16b` | SKIP | TypeScript 7 / plain-node build migration; deferred to dedicated 0.2.0 tooling work |
| 251 | `e473b5cd8b` | REIMPLEMENT | prompt disposition (`handled`/`queued`/`started`) in RPC responses, adapted to Aira session/RPC |

Downstream: **rows 104 (`e4c75a732`) and 121 (`16292398a`) were reclassified
REIMPLEMENT → SKIP** because they are direct follow-ups of the skipped
mid-conversation `SystemMessage` model.

Rejected architecture families (kept out of Aira):
Pico / durable / fork / JSONL runtime, chord, remote three-process presentation,
facets/service-kernel distribution, package/import topology rewrites, Pi release
metadata (versions synced separately), Pi-only docs/evals.

---

## 5. Approved execution-time corrections

| Row | Upstream | Original | Final | Evidence |
|---|---|---|---|---|
| 9 | `caf6dfe7310c` | NDR (Phase 0) | SKIP | Phase 0B; hash erratum corrected |
| 19 | `c1d4c80111` | REIMPLEMENT | SKIP | Pi editor-border status embedding absent from Aira Workbench; Aira renders status in `statusContainer` with its own `CustomEditor`/COMPOSE frame |
| 26 | `f53ac11351` | REIMPLEMENT | SKIP | Pi collapsible fullscreen footer; Aira keeps a persistent footer/status rail (`footerContainer` always populated, `footerRenderedLineCount()` returns 1 or 2) |
| 102 | `fde6d778f8` | DIRECT | SKIP | needs Pi `MouseRegion`/`TuiMouseEvent` hit-testing (base `71026970a`), not carried into Aira's TUI; low-level mouse parsing exists but no reusable component hit-region abstraction |
| 104 | `e4c75a732` | REIMPLEMENT | SKIP | direct follow-up of row 97 `SystemMessage` (verified at execution: 44 SystemMessage/transcript references) |
| 121 | `16292398a` | REIMPLEMENT | SKIP | Phase 0B; follow-up of row 97, partially reverts row 104 |
| **117** | `4658534986` | REIMPLEMENT | **SKIP proposed (pending approval)** | rewrites the `Anthropic dropped …` thinking-drop notice; the notice exists in the Pi 0.85.1 base but never in Aira (no code, no test, no history) |
| **126** | `13784598d2` | REIMPLEMENT | **SKIP proposed (pending approval)** | same absent `maybeShowAssistantDiagnostics` / thinking-drop notice family |

`71026970a feat(tui): add reusable mouse interaction support` is recorded as a
possible future 0.2.0 UI reference only; do not port it during this upsync.

---

## 6. Execution history — commit mappings

### Slice 1 — rows 1–33 (ledger commit `04a0dd126`)

| Row | Upstream | Disposition | Local | Subject |
|---|---|---|---|---|
| 10 | `fcff255b00` | REIMPLEMENT | `15ae5f9c9` | prefer strict sampling for built-in tools by default |
| 11 | `9767ba275f` | DIRECT | `efb54b8f3` | select Radius models after catalog discovery |
| 12 | `e687434a60` | DIRECT | `51985a668` | reject tree navigation during compaction (#9179) |
| 13 | `1f78cea7ad` | DIRECT | `56a45f597` | allow extensions to stream from custom providers (#9272) |
| 16 | `47acd8e6cf` | DIRECT | `273a37ce3` | preserve active operation UI during tree navigation |
| 17 | `7d8ab31a47` | REIMPLEMENT | `00454eb2f` | route Copilot GPT models through Responses |
| 21 | `b2602be77c` | DIRECT | `840604494` | optimize EventStream queue |
| 22 | `96617628e8` | DIRECT | `55d74bf75` | reasoning_effort for reasoning-capable mistral-medium-* |
| 27 | `4a6ed01945` | REIMPLEMENT | `c7542466a` | update runtime dependencies (Aira-relevant subset) |
| 28 | `faa9863cb8` | DIRECT | `2e2d77af7` | run input handlers for queued messages |
| 29 | `6160683a4a` | DIRECT | `16af5d971` | await queue operations in concurrent tests |
| 30 | `561a2e066c` | DIRECT | `56472e2f3` | send OpenCode session header |
| 32 | `c37b0e03b5` | REIMPLEMENT | `26ceac0a2` | cap agent retry backoff |
| 33 | `acaa253cc8` | DIRECT | `332d5b6cf` | validate extension tool parameter schemas |

SKIP rows: 1–9, 14, 15, 18–20, 23–26, 31 (details in the repo ledger).
Notable: row 27 excluded chord/durable workspace deps and Aira's existing
`@anthropic-ai/sdk` pin; locks/shrinkwrap/install-lock regenerated via repo
scripts. Row 17 hydrated provider data through the generator.

### Slice 2 — rows 34–66 (ledger commit `b5d024282`)

| Row | Upstream | Disposition | Local | Subject |
|---|---|---|---|---|
| 41 | `46bde88a1c` | REIMPLEMENT | `602466cc7` | per-model compaction token budgets (Aira projection untouched; ported suite tests calibrated for Aira's larger prompt) |
| 42 | `e86102f18f` | DIRECT | `c411f5b29` | send Codex Off reasoning effort |
| 43 | `6b94ae2ece` | REIMPLEMENT | `b39371ff7` | preserve Fireworks thinking and native effort levels |
| 44 | `519184eb65` | DIRECT | `862e998d9` | accept Fireworks models in adaptive thinking metadata test |
| 45 | `bbb61e34aa` | REIMPLEMENT | `e7964aea7` | OpenRouter session affinity headers by default |
| 46 | `12f59336af` | REIMPLEMENT | `f707f9084` | update DeepSeek Flash catalog |
| 47 | `2e6fe2f988` | REIMPLEMENT | `aea230518` | remove retired GPT-5.4 Codex models |
| 48 | `4bd3f48df0` | REIMPLEMENT | `dd3b27e55` | enable GLM-5.2 reasoning on Mistral |
| 50 | `d92eb8d4b1` | REIMPLEMENT | `02d50248c` | enable Fireworks Messages deferred tool loading |

SKIP rows: 34–40, 49, 51–64, 65, 66 (revert pairs 61↔64 and 66↔80 recorded).
Findings: gpt-6-astra exists in the Pi 0.85.1 base generator but is absent from
Aira's generator/catalog (open parity note; do not fix opportunistically);
row 47's xhigh expectation for gpt-6-astra was therefore not ported.

### Slice 3 — rows 67–99 (ledger commit `35eb4de2b`)

| Row | Upstream | Disposition | Local | Subject |
|---|---|---|---|---|
| 79 | `0c7bb7c5c7` | DIRECT | `4521e7ccc` | identify Responses error providers |
| 86 | `8a7b0c03df` | DIRECT | `909e13e88` | price Bedrock one-hour cache writes |
| 91 | `4c2d91339a` | REIMPLEMENT | `b29c105b9` | export extension event hook types (+ stabilizes the Bedrock cost test) |
| 92 | `3349e1db18` | REIMPLEMENT | `0ef749a0e` | reject unverified local clipboard writes (Aira-native) |
| 93 | `60e7e76bd7` | REIMPLEMENT | `50666a065` | surface clipboard backend failures (Aira-native platform guidance) |
| 94 | `b03a367a4f` | REIMPLEMENT | `0dc4072fa` | allow configuring Anthropic fallback models |
| 95 | `9b791a4cc1` | DIRECT | `a317f01f6` | avoid transcript scans for exact session IDs (#9601) |
| 96 | `6671c60476` | REIMPLEMENT | `e0a8acd33` | send Baseten session affinity headers |
| 99 | `aa50fe778a` | REIMPLEMENT | `9444a38ee` | derive Google thinking levels from models.dev |

SKIP rows: 67–78, 80–85, 87–90, 97, 98 (24). Clipboard rows 92/93 are
Aira-native adaptations; the large `caf6dfe731` native/prebuild refactor (row 9)
was not resurrected. Row 99 dropped the mid-conversation effort machinery
(consistent with row 97 SKIP). Row 86's upstream test hardcoded models.dev
regional prices that later drifted; upstream fixed it at row 91 (in-slice), so
Aira carries the corrected derived-expectation test.

### Slice 4 (in progress) — rows 100–116

| Row | Upstream | Disposition | Local | Subject |
|---|---|---|---|---|
| 100 | merge | SKIP (MRG) | — | constituents accounted for |
| 101 | generated image catalog | SKIP (GEN) | — | generated output; Aira hydrates via `generate-image-models.ts` |
| 102 | `fde6d778f8` | SKIP (UI) | — | approved correction; MouseRegion absent |
| 103 | `509ee2bd0b` | REIMPLEMENT | `b038b49c1` | fail closed on user bash hook errors |
| 104 | `e4c75a732` | SKIP (ARCH) | — | row-97 SystemMessage follow-up |
| 105 | `16235fd935` | REIMPLEMENT | `8f2272462` | avoid unsupported Gemini thinking levels |
| 106 | `1283afd0d0` | REIMPLEMENT | `9cade3b0d` | preserve thinking replay through renamed Anthropic models |
| 107 | `e5d18382a2` | DIRECT | `5c7219ae8` | retry Cloudflare 520 responses |
| 108 | contributor approval | SKIP (SEC) | — | security-sensitive CI authorization |
| 109 | pico docs | SKIP (ARCH) | — | absent architecture |
| 110 | `e98f287ee4` | DIRECT | `0d59b2972` | retry Azure peak-load capacity errors |
| 111–116 | pico/durable/evals | SKIP | — | absent architecture / Pi docs evals |

Ledger commit for rows 100–116: `12941ca33`.
Rows 117–132 are **not processed** (117 and 126 await the SKIP corrections).

---

## 7. Aira-owned dogfood fix — `008a7a77c`

Not an upstream commit; not counted in DIRECT/REIMPLEMENT totals.

### Bug

During the Phase 4 stop report, the assistant produced a long report. After
context compaction, the visible conversation showed
`[rest of older assistant message compacted]` in place of the report, and the
user had to ask for a re-issue.

### Root cause

`compactAiraModelContext` (`packages/coding-agent/src/aira/context-compaction.ts`)
protected only the active user message plus the newest `recentBytes` of
execution history. Assistant output produced **inside the active turn** could
fall outside that window and be compacted. A continuation/retry inside the same
turn then sent the model a truncated view of its own response; the model
continued from the placeholder and persisted the degraded text as canonical
history. Evidence from the dogfood session JSONL: the completed report entry was
persisted with the marker (head + marker only), and a subsequent assistant
message consisted solely of `[older assistant progress text compacted]`.

Fix: hard protection for

1. the active user request and every assistant message produced inside the
   active turn (no continuation from a compacted view of its own response);
2. the most recently completed assistant response (the last assistant message
   before the active user request), so a new user message cannot immediately
   destroy the response being read.

Tool results and older history remain compactable; the projection stays pure,
idempotent, and still triggers.

### Files and tests

- `packages/coding-agent/src/aira/context-compaction.ts`
- `packages/coding-agent/test/aira/context-compaction.test.ts` (new visible-response protection tests + updated long-turn/thinking expectations)
- `packages/coding-agent/test/aira/context-compaction-session.test.ts` (installed-seam regression)

Validation: 58 compaction tests pass, all `test/aira` (1110 tests) pass,
`npm run check` exit 0.

### Before/after impact (instrumented)

| Scenario | Before | After |
|---|---|---|
| Dogfood-shaped (report inside active turn + later tool output) | 187,393 → 45,331 bytes; 9 assistant messages compacted; report lost MIDDLE/END with marker | 187,393 → **138,694** bytes; **0** assistant messages compacted; report BEGIN/MIDDLE/END intact; 7 tool results compacted; 48,699 bytes saved |
| Single long autonomous turn (20 tool pairs) | 190,376 → 44,442; 16 assistants compacted | 190,376 → 98,521; 0 assistants; 15 tool results compacted; 91,855 bytes saved |
| Report then follow-up | 164,668 → 76,783 | 164,668 → 86,217; report verbatim; 9 old-turn assistants still compacted |

Invariants to preserve for the remainder of the upsync (especially row 133 and
any later compaction REIMPLEMENT): active-turn assistant output verbatim;
latest completed assistant response protected; tool results compactable; older
assistant history compactable; canonical session state separate from provider
projection; provider compaction must never cause a continuation to persist
placeholder text as canonical output.

---

## 8. Operational lessons and gotchas

- **`git apply --3way` can import skipped architecture.** During row 106 it
  merged context from the skipped row 97 into the test file. Restore and apply
  exact upstream hunks manually when a commit's blob context contains skipped
  families (rows 104/117/121/126 region, SystemMessage, pico/durable).
- **Rebuild gitignored dists before interpreting spawned-subprocess test
  failures:** `npm run build:offline --workspace @earendil-works/pi-ai`.
  `packages/*/dist` is gitignored; never commit it.
- **E2E contamination:** an installed `ollama` binary activates Ollama E2E tests
  that fail without the right local models. Run vitest directly with a filtered
  `PATH` (exclude the ollama bin directory) or use `./test.sh`, which does not
  hit them.
- **External model-data drift:** models.dev pricing changes (e.g. Bedrock
  regional `us.anthropic.claude-opus-4-8` moved from 5/6.25 to 5.5/6.875) can
  break tests that hardcode prices. Row 91 fixed the Bedrock test in-slice.
- **Known deterministic baseline failures:** `model-registry.test.ts` has 3
  stale `anthropic/claude-opus-4` expectations. They fail at v0.1.9 and are not
  sync regressions; the audited upstream fix arrives at a later row — do not pull
  it forward.
- **gpt-6-astra parity note:** present in the Pi 0.85.1 base generator, absent
  from Aira's generator/catalog. Open informational note; do not fix
  opportunistically.
- **Stop protocol:** if execution evidence contradicts an approved disposition,
  STOP and report (hash, subject, approved vs proposed disposition, evidence,
  consequence). Never silently reclassify. Rows 19, 26, 102 and the dogfood fix
  were handled this way.
- **No child-agent fan-out** for upsync slices: the child tool budget proved
  insufficient during Phase 0; the upsync is parent-driven.
- `/tmp` analysis artifacts (ledger TSVs, scripts, benchmarks) are ephemeral.
  The repository ledger and this document are the durable record; Appendix A
  preserves the approved dispositions for the unprocessed remainder.

---

## 9. Pending approvals and next steps

1. **Row 117 `4658534986` → SKIP (UI)** (proposed). The commit only rewrites the
   `Anthropic dropped …` notice, which Aira has never had (no code, no test, no
   history; present in the Pi 0.85.1 base).
2. **Row 126 `13784598d2` → SKIP (UI)** (proposed). Same absent
   `maybeShowAssistantDiagnostics` family.
3. Then process rows 118–132 in upstream order:
   - 118 REIMPLEMENT (Vercel AI Gateway unsigned thinking; generator + test)
   - 119 DIRECT (fail signal-terminated shell commands)
   - 120 SKIP (changelog)
   - 121 SKIP (row-97 follow-up)
   - 122 DIRECT (event handler unsubscribe)
   - 123, 124 SKIP (chord)
   - 125 REIMPLEMENT (update tests for current model catalogs)
   - 126 SKIP (pending correction)
   - 127 REIMPLEMENT (preserve DeepSeek V4 effort metadata)
   - 128 DIRECT (scope bodyless overflow errors to Cerebras)
   - 129 REIMPLEMENT (format bash tool durations)
   - 130, 131 SKIP
   - 132 DIRECT (reduce fuzzy search latency)
4. STOP after row 132 for the full Phase 4 report. Do not process row 133.
5. Phase 5 note: row 133 is known compaction work; explicitly include
   `008a7a77c` in the comparison and preserve its invariants.

---

## 10. Resume playbook (commands)

Verify state:

```bash
cd /Users/hariz/proj/aira
git branch --show-current          # sync/pi-0.87.1
git rev-parse HEAD                 # expected per §1
git rev-parse main                 # 3c2eb7a67840c0bc80446781bf2549504ad8eb8c
git status --short                 # must be clean
```

Resolve a row's upstream commit:

```bash
git rev-list --reverse da840b621..d6af72e185 | sed -n '117p'   # row 117
```

DIRECT:

```bash
git cherry-pick -n <upstream-sha>
# changelog-only conflicts: keep Aira's file
git checkout --ours packages/<pkg>/CHANGELOG.md && git add packages/<pkg>/CHANGELOG.md
git commit -C <upstream-sha>        # verbatim message + upstream author/date
# verify metadata afterwards
```

REIMPLEMENT: apply hunks (prefer manual near skipped families), then commit as
Aira/Hariz or preserved upstream author for near-faithful ports, with
`(upstream <short-sha>)` in the subject and an `Adapted from …` body line; add or
adapt targeted tests.

SKIP: ledger only, no empty commit.

Validation:

```bash
# targeted tests (example)
(cd packages/ai && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>.test.ts)
npm run check
# slice boundary
npm run build:offline --workspace @earendil-works/pi-ai
./test.sh
```

Ledger: extend `aira_product_docs/phases/PHASE_15_PI_0.87.1_UPSYNC.md` with the
slice table (row, upstream SHA, disposition, local SHA, reason), cumulative
totals, and explicit notes for corrections and revert-pair relationships.
Record the Aira-owned dogfood commits separately from the upstream-sync commits.

Commit messages:

- DIRECT: upstream message verbatim.
- REIMPLEMENT: `type(scope): subject (upstream <short-sha>)` plus
  `Adapted from <Author>'s <full-sha>, <subject>.`
- SKIP: no commit.
- Docs/ledger: `docs(aira): …`.

---

## 11. Reference

- Ledger (authoritative): `aira_product_docs/phases/PHASE_15_PI_0.87.1_UPSYNC.md`
- Compaction protection: `packages/coding-agent/src/aira/context-compaction.ts`
- Generator (source of truth): `packages/ai/scripts/generate-models.ts`; image catalog: `packages/ai/scripts/generate-image-models.ts`
- Session lookup: `packages/coding-agent/src/core/session-manager.ts`
- Extension surface: `packages/coding-agent/src/core/extensions/{types,runner}.ts`
- Prior upsync evidence: `aira_product_docs/phases/PHASE_14_PREPARATION.md`, `PHASE_14_CLOSEOUT.md`
- Baseline note: `BASELINE.md`
- Key hashes: baseline `3c2eb7a67`; safety `backup/pre-pi-0.87.1-sync` = `3c2eb7a67`; Pi base `da840b621`; forked shared history `4e58f324f` (Pi 0.84.3); target `d6af72e185`; dogfood fix `008a7a77c`.
- Known baseline test failure: `packages/coding-agent/test/model-registry.test.ts` (3 stale `anthropic/claude-opus-4` expectations).

## Appendix A — Approved dispositions for unprocessed rows 117–260

Source: the Phase 0/0B approved ledger (proposed dispositions). Rows 117 and 126
carry proposed SKIP corrections pending approval; row 121 is the approved
Phase 0B SKIP. Resolve row N with
`git rev-list --reverse da840b621..d6af72e185 | sed -n 'Np'`.

| # | Upstream SHA | Disposition | Subject | Note |
|---|---|---|---|---|
| 117 | `4658534986` | SKIP (proposed, pending approval) | fix(coding-agent): shorten Anthropic thinking drop notices | UI: rewrites the absent Anthropic thinking-drop notice; Aira has no such code/test/history |
| 118 | `3955b27a1d` | REIMPLEMENT [CATALOG] | fix(ai): preserve Vercel AI Gateway unsigned thinking | port model catalog/generator changes via generate-models.ts and regenerate |
| 119 | `a8b3dd1998` | DIRECT [REL] | fix(coding-agent): fail signal-terminated shell commands | 3-way merge conflicts only in changelog/manifest |
| 120 | `7811394112` | SKIP [REL] | docs(coding-agent): update changelog | changelog-only |
| 121 | `16292398af` | SKIP [REV] | fix(coding-agent): send forced system prompts without recording them | Phase 0B: follow-up of the skipped row 97 SystemMessage model (partially reverts row 104) |
| 122 | `46c9de402b` | DIRECT [REL] | feat(coding-agent): add event handler unsubscribe (#9630) | 3-way merge conflicts only in changelog/manifest |
| 123 | `c4289b20eb` | SKIP [ARCH] | fix(chord): keep tracked paths correct across structural mutation | durable/chord/pico architecture absent from Aira |
| 124 | `328926b30e` | SKIP [ARCH] | docs(chord): describe tracker ownership and aliasing as they behave | durable/chord/pico architecture absent from Aira |
| 125 | `ea9e093516` | REIMPLEMENT | fix(ai): update tests for current model catalogs | source conflict in Aira-diverged files: packages/ai/test/context-overflow.test.ts,packages/ai/test/openai-completions-to |
| 126 | `13784598d2` | SKIP (proposed, pending approval) | fix(coding-agent): suppress repeated Anthropic thinking drop notices | UI: same absent maybeShowAssistantDiagnostics / thinking-drop notice family |
| 127 | `bb0f4aa602` | REIMPLEMENT [CATALOG] | fix(ai): preserve DeepSeek V4 effort metadata | port model catalog/generator changes via generate-models.ts and regenerate |
| 128 | `661619e872` | DIRECT [REL] | fix(ai): scope bodyless overflow errors to Cerebras | 3-way merge conflicts only in changelog/manifest |
| 129 | `fe219d7f8d` | REIMPLEMENT [REL] | feat(coding-agent): format bash tool durations to support hours, minutes, seconds (#9742) | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md |
| 130 | `cf8d5fac30` | SKIP [ARCH] | feat(agent): add Pico storage foundation | durable/chord/pico architecture absent from Aira |
| 131 | `eed5263cdd` | SKIP [MRG] | Merge remote-tracking branch 'origin/main' into HEAD | merge commit; constituents reviewed separately |
| 132 | `5901446094` | DIRECT [REL] | fix(tui): reduce fuzzy search latency | 3-way merge conflicts only in changelog/manifest |
| 133 | `8bdcd4498a` | REIMPLEMENT [REL] | fix(coding-agent): compact oversized trailing tool results | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/test/suite/agent-sessio |
| 134 | `0801601621` | SKIP [ARCH] | feat(durable): move Pico into dedicated package | durable/chord/pico architecture absent from Aira |
| 135 | `cf33309117` | SKIP [MRG] | Merge remote-tracking branch 'origin/main' | merge commit; constituents reviewed separately |
| 136 | `b5ef419d5b` | SKIP [ARCH] | docs(agent): restore non-Pico5 documentation | durable/chord/pico architecture absent from Aira |
| 137 | `1e39862f67` | REIMPLEMENT [REL] | fix(coding-agent): detect llama.cpp chat-template thinking | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/src/extensions/llama/cl |
| 138 | `c1263aa113` | SKIP [ARCH] | fix: clean up delta lint diagnostics | durable/chord/pico architecture absent from Aira |
| 139 | `59eb4c393c` | DIRECT | fix(coding-agent): clarify copy shortcut description (#9745) | 3-way cherry-pick clean |
| 140 | `e4ce7b449f` | REIMPLEMENT [CATALOG] | fix(ai): update Kimi model catalog source | port model catalog/generator changes via generate-models.ts and regenerate |
| 141 | `a16ccd9be8` | SKIP [ARCH] | feat(durable): refine record and query contracts | durable/chord/pico architecture absent from Aira |
| 142 | `0db5659249` | SKIP [ARCH] | fix(durable): index memory storage queries | durable/chord/pico architecture absent from Aira |
| 143 | `734ab3434f` | SKIP [MRG] | Merge remote-tracking branch 'origin/main' into HEAD | merge commit; constituents reviewed separately |
| 144 | `e80cf14011` | SKIP [ARCH] | docs(durable): simplify document runtime contracts | durable/chord/pico architecture absent from Aira |
| 145 | `58541ee721` | SKIP [ARCH] | fix: reduce delta proxy retention and compact cloned objects | durable/chord/pico architecture absent from Aira |
| 146 | `36b60d2e89` | SKIP [ARCH] | fix: clean up delta test lint diagnostics | durable/chord/pico architecture absent from Aira |
| 147 | `3c75b27479` | SKIP | feat(coding-agent): add bug reporting | Phase 0B: Pi bug-reporting feature uploads to the Radius gateway; product/backend decision |
| 148 | `de2de549bc` | REIMPLEMENT [REL] | fix(coding-agent): close compaction cancellation races | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/src/core/agent-session. |
| 149 | `4d38031fbd` | REIMPLEMENT [CATALOG] | feat(ai): ship Radius model catalog | Radius model catalog: Aira has radius provider/auth; needs generator + catalog adaptation |
| 150 | `eba619879c` | SKIP [REL] | docs: audit unreleased changelogs | upstream changelog audit; Aira maintains its own changelogs |
| 151 | `7d5eb0ee3b` | SKIP | fix(ai): mock Radius in model generation tests | all conflict targets absent in Aira (packages/ai/test/fireworks-model-generation.test.ts) |
| 152 | `c596d09d9c` | REIMPLEMENT [CATALOG] | feat(coding-agent): add prompt cache warming (#9668) | port model catalog/generator changes via generate-models.ts and regenerate |
| 153 | `bfa6862400` | REIMPLEMENT | fix(tui): handle CJK punctuation in file autocomplete (#9746) | source conflict in Aira-diverged files: packages/tui/test/editor.test.ts |
| 154 | `40c256cccb` | REIMPLEMENT [REL] | feat(coding-agent): defer extension loader dependencies | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/src/core/extensions/loa |
| 155 | `fa0e1f48ac` | DIRECT [REL] | fix(tui): improve LaTeX compatibility and layouts | 3-way merge conflicts only in changelog/manifest |
| 156 | `b7f7881949` | SKIP | fix(coding-agent): await terminal remote prompt event | all conflict targets absent in Aira (packages/coding-agent/src/experimental/client.ts) |
| 157 | `d7951ec362` | DIRECT | fix(tui): rank skill autocomplete by bare name (#9120) | 3-way cherry-pick clean |
| 158 | `803f0e906d` | DIRECT [REL] | fix(tui): preserve fullscreen images in WezTerm | 3-way merge conflicts only in changelog/manifest |
| 159 | `21b8cc1a4b` | REIMPLEMENT | fix(coding-agent): ignore stale tool image conversions (#8743) | source conflict in Aira-diverged files: packages/coding-agent/test/tool-execution-component.test.ts |
| 160 | `dfbf793b78` | DIRECT [REL] | feat(coding-agent): load session picker progressively | 3-way merge conflicts only in changelog/manifest |
| 161 | `dd01f5b240` | DIRECT | fix(coding-agent): speed up recent session discovery | 3-way cherry-pick clean |
| 162 | `12032deb70` | SKIP [REL] | docs: complete unreleased changelog audit | upstream changelog audit; Aira maintains its own changelogs |
| 163 | `ecac0a9c4e` | SKIP [ARCH] | Release v0.86.0 | durable/chord/pico architecture absent from Aira |
| 164 | `50d766cba2` | SKIP [ARCH] | Add [Unreleased] section for next cycle | durable/chord/pico architecture absent from Aira |
| 165 | `d1230ea200` | SKIP | fix(coding-agent): preserve multiline bug descriptions | part of Pi bug-reporting feature absent from Aira (see row 147) |
| 166 | `b73412a378` | REIMPLEMENT [CATALOG] | feat(ai,coding-agent): add Meta provider with Muse subscription OAuth (#9096) | port model catalog/generator changes via generate-models.ts and regenerate |
| 167 | `60740991c0` | REIMPLEMENT [REL] | feat(coding-agent): cache compiled Node CLI modules | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,scripts/build-coding-agent-bundle.mjs |
| 168 | `d875512cc4` | SKIP | fix(coding-agent): suppress bug hints for expected failures | part of Pi bug-reporting feature absent from Aira (see row 147) |
| 169 | `ee2df312e5` | SKIP [REL] | docs: audit post-release changelog entries | upstream changelog audit; Aira maintains its own changelogs |
| 170 | `6dff740fab` | REIMPLEMENT [REL] | fix(coding-agent): restore OSC 52 clipboard fallback for headless sessions | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/src/utils/clipboard.ts, |
| 171 | `0e283203c7` | DIRECT [REL] | fix(ai): detect z.ai prompt-too-long errors | 3-way merge conflicts only in changelog/manifest |
| 172 | `af7359b904` | REIMPLEMENT [CATALOG] | fix(ai): exclude Cerebras from supportsStrictMode (#9804) | port model catalog/generator changes via generate-models.ts and regenerate |
| 173 | `199160a6a8` | SKIP [REL] | docs(coding-agent): document inherited z.ai overflow fix | upstream changelog note; Aira maintains its own changelogs |
| 174 | `68f98022e3` | SKIP [REL] | docs: audit Cerebras fix changelog entries | upstream changelog audit; Aira maintains its own changelogs |
| 175 | `13cbf77df2` | SKIP [ARCH] | Release v0.86.1 | durable/chord/pico architecture absent from Aira |
| 176 | `19451accde` | SKIP [ARCH] | Add [Unreleased] section for next cycle | durable/chord/pico architecture absent from Aira |
| 177 | `3390bd9363` | REIMPLEMENT [REL] | fix(coding-agent): skip late cache warming refreshes | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md |
| 178 | `f5c946480c` | REIMPLEMENT [CATALOG] | feat(ai,coding-agent): add image input limits (closes #9631) | port model catalog/generator changes via generate-models.ts and regenerate |
| 179 | `63787ee6ba` | REIMPLEMENT [REL] | feat(coding-agent): identify extensions in crash stacks | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/src/modes/interactive/i |
| 180 | `890f920884` | REIMPLEMENT [CATALOG] | fix(ai): default unknown providers to non-strict tools (closes #9816) | port model catalog/generator changes via generate-models.ts and regenerate |
| 181 | `8bfef4de88` | REIMPLEMENT | fix(ai): update strict mode test expectations | source conflict in Aira-diverged files: packages/ai/test/cache-retention.test.ts |
| 182 | `47a18e37b1` | DIRECT [REL] | fix: require complete GIF image signatures | 3-way merge conflicts only in changelog/manifest |
| 183 | `c7cdb460aa` | SKIP | fix(coding-agent): reject bug reports offline | part of Pi bug-reporting feature absent from Aira (see row 147) |
| 184 | `1e0fe20497` | SKIP | fix(coding-agent): allow offline bug report exports (#9841) | part of Pi bug-reporting feature absent from Aira (see row 147) |
| 185 | `b6419322e6` | DIRECT [REL] | fix(coding-agent): report invalid prompt frontmatter (#9830) | 3-way merge conflicts only in changelog/manifest |
| 186 | `9ac95c7151` | SKIP [REL] | docs(coding-agent): audit unreleased changelog | upstream changelog audit; Aira maintains its own changelogs |
| 187 | `10d1ad621f` | SKIP [ARCH] | feat: add transactional replicated state | durable/chord/pico architecture absent from Aira |
| 188 | `466db0fecd` | REIMPLEMENT [ARCH] | feat: add canonical session context boundaries | Phase 0B: canonical session context boundaries; not pico/durable; intersects Session/Branch/AgentLane; depends on row 97 |
| 189 | `aef5fc429b` | REIMPLEMENT [REL] | fix(coding-agent): keep prompt and tool state across context handlers (#9846) | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/src/core/extensions/ind |
| 190 | `8c72793785` | REIMPLEMENT | fix(tui): prevent jump-to-end label from shifting when scrollbar hides (#9842) | source conflict in Aira-diverged files: packages/tui/src/tui-alt-screen.ts,packages/tui/test/tui-alt-screen.test.ts |
| 191 | `7f06f9cf16` | SKIP [REL] | docs(coding-agent): complete unreleased changelog | upstream changelog audit; Aira maintains its own changelogs |
| 192 | `eaf72ed4d8` | REIMPLEMENT | fix(coding-agent): update stale test expectations | source conflict in Aira-diverged files: packages/coding-agent/test/model-registry.test.ts |
| 193 | `16787ad5b2` | SKIP [ARCH] | Release v0.87.0 | durable/chord/pico architecture absent from Aira |
| 194 | `4c8eb393c7` | SKIP [ARCH] | Add [Unreleased] section for next cycle | durable/chord/pico architecture absent from Aira |
| 195 | `1b6ddca87c` | DIRECT [REL] | fix(ai): omit empty text parts from multimodal user messages | 3-way merge conflicts only in changelog/manifest |
| 196 | `1a584a7a56` | REIMPLEMENT [CATALOG] | feat(ai,coding-agent): add Grok 4.7 support | port model catalog/generator changes via generate-models.ts and regenerate |
| 197 | `e40126f578` | DIRECT | fix(coding-agent): reject invalid --mode values | 3-way cherry-pick clean |
| 198 | `95fbc04997` | SKIP [REL] | docs(coding-agent): update changelog with --mode validation fix (#9877) | upstream changelog note; Aira maintains its own changelogs |
| 199 | `8158b03213` | SKIP [ARCH] | feat(durable): add versioned document storage | durable/chord/pico architecture absent from Aira |
| 200 | `d201760ffe` | SKIP [MRG] | Merge remote-tracking branch 'origin/main' | merge commit; constituents reviewed separately |
| 201 | `25cc5c7bf4` | SKIP [DOC/EVAL] | docs(coding-agent): refresh documentation (#9898) | full upstream docs refresh for Pi product surface; Aira docs are separate |
| 202 | `d192bd6dca` | REIMPLEMENT [REL] | fix(coding-agent): avoid Fable split-turn summary refusals (#9908) | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/test/suite/agent-sessio |
| 203 | `5901c9b9e5` | SKIP [ARCH] | feat: add durable SQLite storage backend | durable/chord/pico architecture absent from Aira |
| 204 | `2c2cd636f3` | SKIP [MRG] | Merge remote-tracking branch 'origin/main' into durable-push-5901c9b9e | merge commit; constituents reviewed separately |
| 205 | `81274f0e18` | SKIP [ARCH] | fix: verify durable browser-safe exports | durable browser-smoke check; Aira has no durable package |
| 206 | `b4588f26af` | REIMPLEMENT [CATALOG] | feat(ai,coding-agent): add Claude Opus 5.5 support | port model catalog/generator changes via generate-models.ts and regenerate |
| 207 | `3a624b82dd` | DIRECT [REL] | fix(ai): update reported Claude Code version | 3-way merge conflicts only in changelog/manifest |
| 208 | `db91e03319` | REIMPLEMENT [CATALOG] | feat(ai,coding-agent): add GPT-6 Sol and Luna support | port model catalog/generator changes via generate-models.ts and regenerate |
| 209 | `27c072e98f` | REIMPLEMENT [CATALOG] | feat(ai,coding-agent): add new Copilot models | port model catalog/generator changes via generate-models.ts and regenerate |
| 210 | `b7f4b05c7f` | REIMPLEMENT [CATALOG] | fix(ai): stabilize Claude Opus 5.5 effort levels | port model catalog/generator changes via generate-models.ts and regenerate |
| 211 | `3a4c777f26` | SKIP [REL] | docs(coding-agent): complete unreleased changelog | upstream changelog audit; Aira maintains its own changelogs |
| 212 | `f07218c4d4` | SKIP [ARCH] | Release v0.87.1 | durable/chord/pico architecture absent from Aira |
| 213 | `a8ed497713` | SKIP [ARCH] | Add [Unreleased] section for next cycle | durable/chord/pico architecture absent from Aira |
| 214 | `a32782520f` | SKIP [ARCH] | docs: propose Pico5 live extension registries | durable/chord/pico architecture absent from Aira |
| 215 | `9672462143` | SKIP [ARCH] | docs: refine Pico5 JSONL publication design | durable/chord/pico architecture absent from Aira |
| 216 | `898ab80405` | SKIP [ARCH] | feat: add durable JSONL storage backend | durable/chord/pico architecture absent from Aira |
| 217 | `9a139c62bf` | SKIP [ARCH] | feat(chord): consolidate immutable delta tracking | durable/chord/pico architecture absent from Aira |
| 218 | `4bc1a2fe53` | SKIP [ARCH] | feat(chord): add optimized delta engine prototypes | durable/chord/pico architecture absent from Aira |
| 219 | `b313731b80` | SKIP [ARCH] | feat: add JSONL sidecar reclamation | durable/chord/pico architecture absent from Aira |
| 220 | `4c2dfd9362` | SKIP [REL] | chore: regenerate image models | CI/release automation only |
| 221 | `fde38ed7c2` | REIMPLEMENT [CATALOG] | fix(ai): stabilize Copilot Claude Opus 5.5 effort levels | port model catalog/generator changes via generate-models.ts and regenerate |
| 222 | `36af9dc48e` | REIMPLEMENT [REL] | fix(tui): restore skill prefix autocomplete, closes #9944 | source conflict in Aira-diverged files: packages/tui/CHANGELOG.md,packages/tui/src/autocomplete.ts |
| 223 | `8d897edaa6` | REIMPLEMENT [REL] | fix(coding-agent): prevent duplicate extension runtimes (closes #9863) | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/docs/packages.md |
| 224 | `002fc83852` | REIMPLEMENT | feat: expose provider stream events to extensions (#9901) | Phase 0B: provider stream events to extensions (onProviderStreamEvent + provider_stream_event) |
| 225 | `667fc3dd36` | REIMPLEMENT [REL] | fix(ai): price Vercel AI Gateway 1-hour cache writes correctly | source conflict in Aira-diverged files: packages/ai/CHANGELOG.md,packages/ai/src/api/anthropic-messages.ts |
| 226 | `a328aa89ad` | SKIP | feat(ai,coding-agent): unify image and classifier model infrastructure (#9948) | Phase 0B: image/classifier model-kind infrastructure; no Aira classifier consumer |
| 227 | `7fd564cbb7` | SKIP | feat: share model catalog protocol with pi.dev (#9763) | publishes Pi model-catalog protocol to pi.dev via .github workflow; Aira does not run that publication |
| 228 | `b45597504e` | SKIP [ARCH] | feat(durable): export scoped storage conformance suite (#9977) | durable/chord/pico architecture absent from Aira |
| 229 | `8676a0dcd8` | REIMPLEMENT [REL] | fix(coding-agent): require advertised X11 clipboard images | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md,packages/coding-agent/src/utils/clipboard-ima |
| 230 | `7c696c00f3` | SKIP [ARCH] | docs: revise Pico5 immutable revision design | durable/chord/pico architecture absent from Aira |
| 231 | `a7d17e39aa` | SKIP | feat(ai): serve Jev classifier through OpenRouter and Cloudflare Workers AI | Phase 0B: Jev classifier via OpenRouter/Cloudflare; depends on row 226 |
| 232 | `601437d5a7` | SKIP [ARCH] | fix(durable): test execution environment and fix output truncation metadata | durable/chord/pico architecture absent from Aira |
| 233 | `481c7232f1` | SKIP [ARCH] | docs(durable): align Pico5 with canonical immutable tracker | durable/chord/pico architecture absent from Aira |
| 234 | `cbe7cf00be` | SKIP [ARCH] | docs(durable): move Pico5 strict-JSON checks to roots and Chord placements | durable/chord/pico architecture absent from Aira |
| 235 | `3f0573877e` | SKIP [ARCH] | feat(durable): export storage benchmark workloads | durable/chord/pico architecture absent from Aira |
| 236 | `5674690966` | REIMPLEMENT | feat(tui,coding-agent): add color values and theme styling (#8398) | theme/color values rework: adapt to Aira theme system (aira-zhr/custom themes) |
| 237 | `d5cba1d97c` | SKIP [ARCH] | feat(chord): make immutable delta tracker canonical | durable/chord/pico architecture absent from Aira |
| 238 | `d5629e2048` | REIMPLEMENT [REL] | fix(tui): autocomplete paths after opening wrappers like ( and backticks | source conflict in Aira-diverged files: packages/tui/CHANGELOG.md,packages/tui/src/autocomplete.ts,packages/tui/src/comp |
| 239 | `6966636dbe` | SKIP [ARCH] | fix(chord): allow promise probes on settled drafts | durable/chord/pico architecture absent from Aira |
| 240 | `7cf037c218` | DIRECT [REL] | fix(tui): choose Kitty image dimensions by aspect distortion (#9957) | 3-way merge conflicts only in changelog/manifest |
| 241 | `19a0361be8` | SKIP [ARCH] | feat(durable): add transactional sessions and documents | durable/chord/pico architecture absent from Aira |
| 242 | `5d4de953ce` | SKIP [ARCH] | feat(durable): add checkpoints and document migrations | durable/chord/pico architecture absent from Aira |
| 243 | `b2bd111f2d` | DIRECT [REL] | feat(coding-agent): add hidden-message toggle to HTML exports (#10020) | 3-way merge conflicts only in changelog/manifest |
| 244 | `9e70c3d505` | SKIP [ARCH] | feat(chord): optimize immutable batch application | durable/chord/pico architecture absent from Aira |
| 245 | `5fd446ca18` | SKIP [ARCH] | feat(durable): optimize document replay | durable/chord/pico architecture absent from Aira |
| 246 | `f444ea5eaf` | DIRECT [REL] | fix(coding-agent): use per-ref cache folders for pinned temporary git extensions | 3-way merge conflicts only in changelog/manifest |
| 247 | `92e8d4f02a` | DIRECT [REL] | fix(coding-agent): stop RpcClient skipping listeners on unsubscribe | 3-way merge conflicts only in changelog/manifest |
| 248 | `49681e1b71` | REIMPLEMENT [REL] | fix(coding-agent): hide line range for full-file read calls with null offset/limit | source conflict in Aira-diverged files: packages/coding-agent/CHANGELOG.md |
| 249 | `ca7460d16b` | SKIP | feat: build with TypeScript 7 and run sources with plain node | Phase 0B: TypeScript 7 / plain-node build migration deferred to dedicated tooling work |
| 250 | `b3487650f6` | DIRECT [REL] | fix(tui): keep cursor visible when overlays close after stop | 3-way merge conflicts only in changelog/manifest |
| 251 | `e473b5cd8b` | REIMPLEMENT | feat(coding-agent): report prompt disposition in RPC responses | Phase 0B: prompt disposition in RPC responses; adapt to Aira session/RPC |
| 252 | `ddba596187` | DIRECT | fix(coding-agent): honor truecolor in custom themes (fixes #9973) (#10039) | 3-way cherry-pick clean |
| 253 | `c01f687e5b` | DIRECT [REL] | fix(ai): apply model samplingParams in direct stream()/complete() calls | 3-way merge conflicts only in changelog/manifest |
| 254 | `8930b9ec0b` | REIMPLEMENT [REL] | fix(ai): ignore empty Mistral content deltas | source conflict in Aira-diverged files: packages/ai/CHANGELOG.md,packages/ai/test/mistral-http-transport.test.ts |
| 255 | `507d7649e9` | SKIP [ARCH] | feat(durable): add conversation document forks | durable/chord/pico architecture absent from Aira |
| 256 | `ff72faba28` | DIRECT [REL] | fix(coding-agent): save new session file at the first user message | 3-way merge conflicts only in changelog/manifest |
| 257 | `ab30693d64` | REIMPLEMENT | fix(ai): upgrade openai SDK to 7.19.0 (#10044) | source conflict in Aira-diverged files: package-lock.json,packages/ai/package.json,packages/ai/src/api/openai-responses. |
| 258 | `a6ca861024` | REIMPLEMENT [REL] | fix(ai): price OpenAI Fast mode service tier like priority | source conflict in Aira-diverged files: packages/ai/CHANGELOG.md,packages/ai/test/openai-responses-compat.test.ts |
| 259 | `04b5bad666` | SKIP [ARCH] | feat(durable): add typed IDs and explicit ownership | durable/chord/pico architecture absent from Aira |
| 260 | `d6af72e185` | SKIP [ARCH] | docs(durable): clarify scratch examples | durable/chord/pico architecture absent from Aira |

Counts in rows 117–260 (with the two proposed SKIP corrections): DIRECT=24, REIMPLEMENT=45, SKIP=75

Reconciliation:
- Phase 0/0B approved totals (all 260 rows): **DIRECT 42 / REIMPLEMENT 69 / SKIP 149**.
- Approved execution corrections to date: row 19 R->S, row 26 R->S, row 102 D->S, row 104 R->S, row 121 R->S => current approved totals **DIRECT 41 / REIMPLEMENT 65 / SKIP 154** (260).
- Processed rows 1-116: **DIRECT 17 / REIMPLEMENT 20 / SKIP 79** (116).
- Remaining rows 117-260 with rows 117/126 counted as their proposed SKIP: **DIRECT 24 / REIMPLEMENT 45 / SKIP 75** (144). If the 117/126 corrections are not approved, the remainder is DIRECT 24 / REIMPLEMENT 47 / SKIP 73, and the totals become DIRECT 41 / REIMPLEMENT 67 / SKIP 152.
- When a row is executed, the ledger table in `PHASE_15_PI_0.87.1_UPSYNC.md` becomes authoritative for it.

