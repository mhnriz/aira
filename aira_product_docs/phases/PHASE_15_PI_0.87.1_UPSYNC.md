# Phase 15 - Pi 0.87.1 upsync execution ledger

Aira 0.2.0 synchronization from Pi 0.85.1 to Pi 0.87.1 and unreleased
`upstream/main`. Phase 0/0B reconnaissance and dispositions are recorded in
the Phase 0 report; this file is the authoritative execution ledger and is
extended slice by slice.

- Baseline: `3c2eb7a67840c0bc80446781bf2549504ad8eb8c` (Aira v0.1.9)
- Safety ref: `backup/pre-pi-0.87.1-sync`
- Work branch: `sync/pi-0.87.1`
- Upstream range: `da840b621..d6af72e185` (Pi 0.85.1 + [Unreleased] -> Pi 0.87.1 + unreleased)
- Total upstream commits: 260

## Slice 1 (rows 1-33)

| # | Upstream SHA | Date | Subject | Disposition | Local SHA | Notes |
|---|---|---|---|---|---|---|
| 1 | `2e2805d92f` | 2026-09-03 | feat(agent): construct memory forks directly from live state | SKIP | `` | agent memory-fork prototype built on Pi fork runtime; Aira harness owns forking (absent pico/JSONL machinery) |
| 2 | `04d17a1080` | 2026-09-04 | feat(agent): add two-pass JSONL fork prototype | SKIP | `` | legacy JSONL fork prototype absent from Aira harness; superseded by Aira MutationLine/Session/Branch/AgentLane model |
| 3 | `9ee703230f` | 2026-09-04 | Merge remote-tracking branch 'origin/main' into dev-named-forks-streaming | SKIP | `` | merge commit; constituents reviewed separately |
| 4 | `420deedf81` | 2026-09-04 | docs(agent): record JSONL fork capture question | SKIP | `` | all conflict targets absent in Aira (packages/agent/docs/work-packages/08-named-branch-streaming-forks.md) |
| 5 | `89670bc4a6` | 2026-09-04 | fix(agent): reduce JSONL fork list index memory | SKIP | `` | all conflict targets absent in Aira (packages/agent/src/harness/session/jsonl/fork.ts) |
| 6 | `e3c966b6ff` | 2026-09-04 | fix(agent): reject open legacy JSONL forks | SKIP | `` | legacy JSONL fork rejection logic for Pi runtime absent in Aira |
| 7 | `9908b2176a` | 2026-09-04 | feat(agent): fork closed legacy JSONL through format 4 | SKIP | `` | legacy JSONL fork format migration for Pi runtime absent in Aira |
| 8 | `85186f823d` | 2026-09-04 | fix(agent): expand fork conformance for Memory and JSONL | SKIP | `` | legacy JSONL fork conformance work for Pi pico/durable runtime absent in Aira |
| 9 | `caf6dfe731` | 2026-09-05 | feat(tui): Simplify clipboard handling (#9163) | SKIP | `` | [PKG] native/prebuild clipboard refactor tied to Pi packaging; Aira keeps @mariozechner/clipboard + own clipboard-native.ts |
| 10 | `fcff255b00` | 2026-09-05 | feat(coding-agent): prefer strict sampling for built-in tools by default | REIMPLEMENT | `15ae5f9c9` | near-faithful port of the built-in tool strict-sampling default; Aira-only server/create-harness.ts updated because the experimental helper is removed; CHANGELOG kept by Aira | attribution: author preserved |
| 11 | `9767ba275f` | 2026-09-06 | fix(coding-agent): select Radius models after catalog discovery | DIRECT | `efb54b8f3` | Radius provider exists in Aira; 3-way merge clean | attribution: author preserved |
| 12 | `e687434a60` | 2026-09-07 | fix(coding-agent): reject tree navigation during compaction (#9179) | DIRECT | `51985a668` | 3-way cherry-pick clean | attribution: author preserved |
| 13 | `1f78cea7ad` | 2026-09-07 | fix(coding-agent): allow extensions to stream from custom providers (#9272) | DIRECT | `56a45f597` | 3-way merge conflicts only in changelog/manifest | attribution: author preserved |
| 14 | `6dfc66d32a` | 2026-09-07 | feat(agent): stream legacy JSONL migration and forks | SKIP | `` | legacy JSONL fork migration for Pi runtime absent in Aira |
| 15 | `d3ba857ef4` | 2026-09-07 | Merge remote-tracking branch 'origin/main' into dev-named-forks-streaming | SKIP | `` | merge commit; constituents reviewed separately |
| 16 | `47acd8e6cf` | 2026-09-07 | fix(coding-agent): preserve active operation UI during tree navigation | DIRECT | `273a37ce3` | 3-way cherry-pick clean | attribution: author preserved |
| 17 | `7d8ab31a47` | 2026-09-07 | fix(ai): route Copilot GPT models through Responses (#9253) | REIMPLEMENT | `00454eb2f` | generator port; Aira provider data hydrated through scripts/generate-models.ts (data dir is gitignored), no manual generated-file edits | attribution: author preserved |
| 18 | `aa23e784c6` | 2026-09-07 | fix(coding-agent): update repository links to "earendil-works/pi" (#9278) | SKIP | `` | rewrites repository links to upstream earendil-works/pi; Aira keeps its own fork identity |
| 19 | `c1d4c80111` | 2026-09-07 | fix(coding-agent): embed all session status spinners in the editor border | SKIP | `` | [UI] approved correction: Pi editor-border status architecture absent from Aira; Aira renders status in statusContainer with its own CustomEditor/COMPOSE frame |
| 20 | `9211da1723` | 2026-09-07 | feat: add implementation-backed documentation evals (#9280) | SKIP | `` | implementation-backed docs evals reference upstream docs; Aira evals package only keeps smoke/extensions evals |
| 21 | `b2602be77c` | 2026-09-07 | fix(ai): optimize EventStream queue | DIRECT | `840604494` | 3-way merge conflicts only in changelog/manifest | attribution: author preserved |
| 22 | `96617628e8` | 2026-09-08 | fix(ai): use reasoning_effort for reasoning-capable mistral-medium-* models | DIRECT | `55d74bf75` | 3-way merge conflicts only in changelog/manifest | attribution: author preserved |
| 23 | `d0963bf06a` | 2026-09-08 | docs(agent): relax WP08 fork streaming requirements | SKIP | `` | all conflict targets absent in Aira (packages/agent/docs/work-packages/08-named-branch-streaming-forks.md) |
| 24 | `41218b3940` | 2026-09-08 | fix(agent): relax fork lane validation and sequence conformance | SKIP | `` | all conflict targets absent in Aira (packages/agent/docs/work-packages/08-named-branch-streaming-forks.md,packages/agent/src/harness/session/in-memory-storage-state.ts,packages/agent/src/harness/session/jsonl/fork.ts) |
| 25 | `3e4bc2680e` | 2026-09-08 | Merge branch 'dev-named-forks-streaming' | SKIP | `` | merge commit; constituents reviewed separately |
| 26 | `f53ac11351` | 2026-09-08 | fix(coding-agent): collapse empty fullscreen footers | SKIP | `` | [UI] approved correction: Aira keeps a persistent footer/status rail (footerContainer always populated, footerRenderedLineCount() returns 1 or 2); empty-footer precondition does not exist |
| 27 | `4a6ed01945` | 2026-09-08 | fix(coding-agent): update runtime dependencies (#9341) | REIMPLEMENT | `c7542466a` | [DEPS] subset port of shared runtime dependency bumps; @anthropic-ai/sdk pin and chord/durable workspace deps excluded; lock/shrinkwrap/install-lock regenerated via repo scripts | attribution: author preserved |
| 28 | `faa9863cb8` | 2026-09-08 | fix(coding-agent): run input handlers for queued messages | DIRECT | `2e2d77af7` | 3-way merge conflicts only in changelog/manifest | attribution: author preserved |
| 29 | `6160683a4a` | 2026-09-08 | fix(coding-agent): await queue operations in concurrent tests | DIRECT | `16af5d971` | 3-way cherry-pick clean | attribution: author preserved |
| 30 | `561a2e066c` | 2026-09-09 | fix(ai): send OpenCode session header | DIRECT | `56472e2f3` | 3-way merge conflicts only in changelog/manifest | attribution: author preserved |
| 31 | `be26e32704` | 2026-09-09 | docs: extract interactive testing and release guidance into skills (#9370) | SKIP | `` | extracts Pi interactive-testing/release guidance skills; Aira maintains its own contributor docs |
| 32 | `c37b0e03b5` | 2026-09-09 | fix: cap agent retry backoff | REIMPLEMENT | `26ceac0a2` | [RETRY] partial port: ai retry util + settings + AgentSession; Pi harness/runtime/drive absent from Aira | attribution: author preserved |
| 33 | `acaa253cc8` | 2026-09-09 | fix(coding-agent): validate extension tool parameter schemas | DIRECT | `332d5b6cf` | 3-way merge conflicts only in changelog/manifest | attribution: author preserved |

Totals for rows 1-33: DIRECT=10, REIMPLEMENT=4, SKIP=19, TOTAL=33


## Disposition and hash corrections vs the Phase 0/0B ledger

1. Row 9 hash erratum: the Phase 0 compact rendering printed `5f1eef8a34`,
   which does not resolve anywhere in the repository. The row is
   `caf6dfe7310c2860b152ed286f83eeb19ca6631c` (clipboard refactor).
   Disposition unchanged (SKIP, approved in Phase 0B).
2. Row 19 `c1d4c80111` REIMPLEMENT -> SKIP (approved during execution):
   the upstream change refines Pi's editor-border status embedding, which
   Aira does not have; Aira renders status in `statusContainer` with its own
   `CustomEditor`/COMPOSE frame. Reimplementing would introduce a new
   Pi-derived UX mechanism, not preserve existing behavior.
3. Row 26 `f53ac11351` REIMPLEMENT -> SKIP (approved during execution):
   upstream fixes a collapsible fullscreen footer that can render zero rows;
   Aira's Workbench keeps a persistent footer/status rail
   (`footerContainer` always populated, `footerRenderedLineCount()` returns
   1 or 2), so the empty-footer precondition does not exist.
4. Row 27 `4a6ed01945` scope: subset port of shared runtime dependency bumps.
   Excluded from the upstream change: `chord`/`durable` workspace
   dependencies and Aira's existing `@anthropic-ai/sdk` pin. Lockfile,
   `npm-shrinkwrap.json` and `install-lock` were regenerated with the
   repository scripts.
5. Row 32 `c37b0e03b5` scope: partial port into `packages/ai/src/utils/retry.ts`,
   `settings-manager.ts`, `agent-session.ts` and docs/tests. Pi's
   `packages/agent/src/harness/runtime/drive/**` retry machinery is absent
   from Aira and was not imported.
6. Row 10 `fcff255b00` execution detail: the four built-in tools and the
   Aira-only `server/create-harness.ts` switch to the strict-preference
   sampling default because the experimental helper is deleted.
7. Row 17 `7d8ab31a47` execution detail: the generator is the source of
   truth. `packages/ai/src/providers/data/` is gitignored and was hydrated
   through `scripts/generate-models.ts`; no generated file was edited by
   hand.
8. Row 33 end-hash confirmation: the earlier compact rendering's
   `5d2c6ff4c9` does not resolve; the authoritative row 33 commit is
   `acaa253cc8e3`.

## Attribution convention applied

- DIRECT: upstream author name/email and author timestamp preserved exactly,
  upstream message verbatim, no upstream trailers; Aira/Hariz is committer
  with application time; CHANGELOG conflicts resolved in favor of Aira's
  CHANGELOG.
- REIMPLEMENT: upstream behavioral intent preserved and bounded to the
  commit's purpose; upstream short SHA in the subject and the full SHA in
  the "Adapted from" body line; upstream authorship preserved for
  near-faithful ports.
