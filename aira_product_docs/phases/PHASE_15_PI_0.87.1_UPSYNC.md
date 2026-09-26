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

## Slice 2 (rows 34-66)

| # | Upstream SHA | Date | Subject | Disposition | Local SHA | Notes |
|---|---|---|---|---|---|---|
| 34 | `f3564a1d41` | 2026-09-09 | docs: validate documentation navigation and reachability (#9380) | SKIP | `` | [DOC] Pi pico navigation docs; architecture absent from Aira |
| 35 | `73f3257ddc` | 2026-09-07 | docs(agent): preserve pico2 spike design for review | SKIP | `` | [DOC] Pi pico product docs; architecture absent from Aira |
| 36 | `e045ed2f33` | 2026-09-09 | docs(agent): add pico design drafts | SKIP | `` | [DOC] Pi pico product docs; architecture absent from Aira |
| 37 | `2188891bf3` | 2026-09-09 | docs(agent): resolve pico context and state ordering | SKIP | `` | [DOC] Pi pico UI docs; architecture absent from Aira |
| 38 | `ce5ec9ca35` | 2026-09-09 | docs(agent): persist pico entry projections | SKIP | `` | [DOC] Pi pico docs; architecture absent from Aira |
| 39 | `05c6229813` | 2026-09-09 | docs(agent): settle pico task lifecycle | SKIP | `` | [ARCH] Pi pico named-branch runtime work; absent from Aira harness |
| 40 | `400d6905ce` | 2026-09-09 | docs(agent): make pico input attribution explicit | SKIP | `` | [ARCH] Pi pico named-branch runtime work; absent from Aira harness |
| 41 | `46bde88a1c` | 2026-09-07 | feat(coding-agent): support per-model compaction token budgets | REIMPLEMENT | `602466cc7` | [COMPACT] per-model compaction token budgets ported to shared settings/session paths; aira/context-compaction.ts untouched; ported suite tests calibrated for Aira prompt size |
| 42 | `e86102f18f` | 2026-09-10 | fix(ai): send Codex Off reasoning effort | DIRECT | `c411f5b29` | Codex Off reasoning effort sent verbatim; changelog kept by Aira |
| 43 | `6b94ae2ece` | 2026-09-10 | fix(ai): preserve Fireworks thinking and native effort levels | REIMPLEMENT | `b39371ff7` | [CATALOG] generator port for Fireworks thinking/effort; data hydrated through generate-models.ts |
| 44 | `519184eb65` | 2026-09-10 | fix(ai): accept Fireworks models in adaptive thinking metadata test | DIRECT | `862e998d9` | test-only expectation accepting Fireworks models |
| 45 | `bbb61e34aa` | 2026-09-10 | fix(ai): send OpenRouter session affinity headers by default | REIMPLEMENT | `e7964aea7` | [AI] OpenRouter x-session-id default in shared ai api; Aira anthropic compat signature adapted; data hydrated |
| 46 | `12f59336af` | 2026-09-10 | fix(ai): update DeepSeek Flash catalog | REIMPLEMENT | `f707f9084` | [CATALOG] DeepSeek Flash catalog rename; generator block replaced with upstream post-commit block; data hydrated |
| 47 | `2e6fe2f988` | 2026-09-10 | fix(ai): remove retired GPT-5.4 Codex models | REIMPLEMENT | `aea230518` | [CATALOG] removes retired gpt-5.4 entries; test expectation for gpt-6-astra not ported because that model is absent from Aira openai-codex catalog (base-parity gap carried since the 0.85.1 sync) |
| 48 | `4bd3f48df0` | 2026-09-10 | fix(ai): enable GLM-5.2 reasoning on Mistral | REIMPLEMENT | `dd3b27e55` | [AI] near-faithful GLM-5.2 reasoning fix on shared mistral api |
| 49 | `08dc60bc52` | 2026-09-10 | docs(agent): settle pico driver and storage contracts | SKIP | `` | [ARCH] durable/pico storage docs; absent from Aira |
| 50 | `d92eb8d4b1` | 2026-09-10 | feat(ai): enable Fireworks Messages deferred tool loading | REIMPLEMENT | `02d50248c` | [CATALOG] Fireworks deferred tool loading via supportsToolReferences; data hydrated |
| 51 | `fcdc40e175` | 2026-09-10 | chore: approve contributors from issue #9323 | SKIP | `` | [SEC] security-sensitive CI contributor authorization; prior ledger REJECTED class |
| 52 | `b734a75634` | 2026-09-10 | docs(agent): pico handoff for outstanding decisions | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 53 | `1b5aa80aec` | 2026-09-10 | docs(agent): tagged-union task state and derived orphaned variant | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 54 | `378977cd3d` | 2026-09-10 | docs(agent): simplify input results and unify queued input | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 55 | `66f3b138fe` | 2026-09-10 | docs(agent): note foreground dependencies on background work | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 56 | `c7eee01950` | 2026-09-10 | docs(agent): scope out permissions, migration and the wire schema | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 57 | `2176b9dd8f` | 2026-09-10 | docs(agent): runtime schema bundle as a work item | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 58 | `66b72dd783` | 2026-09-10 | docs(agent): turn tasks gate model-visible appends | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 59 | `d12cd92e45` | 2026-09-10 | docs(agent): guide notes for appending entries | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 60 | `62129190d8` | 2026-09-11 | docs(agent): status lives in task state | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 61 | `e8413008cd` | 2026-09-11 | fix(ai): update stale DeepSeek Flash test model IDs | SKIP | `` | [REV] part of the DeepSeek test-ID revert pair with row 64 (713bdf38d5 reverts e8413008cd); net zero, neither side ported |
| 62 | `7b4cfd6eb0` | 2026-09-11 | docs(agent): define pico system sections and mutable registries | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 63 | `f3c672245d` | 2026-09-11 | docs(agent): require typed status payloads for pico task writes | SKIP | `` | [ARCH] durable/Pico runtime; absent from Aira |
| 64 | `713bdf38d5` | 2026-09-11 | Revert "fix(ai): update stale DeepSeek Flash test model IDs" | SKIP | `` | [REV] revert of row 61 e8413008cd; net zero, neither side ported |
| 65 | `b215884021` | 2026-09-11 | feat(coding-agent): add customization documentation evals (#9491) | SKIP | `` | [EVAL] Pi customization documentation evals; Aira evals package keeps only smoke/extensions evals |
| 66 | `71dca871bc` | 2026-09-11 | fix(ci): Fix a broken test | SKIP | `` | [REV] reverted by row 80 (ceea48f5d5 reverts 71dca871bc); net zero, revert lands in the next slice |

Slice 2 totals: DIRECT=2, REIMPLEMENT=7, SKIP=24, TOTAL=33

Cumulative totals rows 1-66: DIRECT=12, REIMPLEMENT=11, SKIP=43, TOTAL=66

### Slice 2 notes

- Row 41 keeps Aira's deterministic projection compaction (`aira/context-compaction.ts`) untouched; only the shared token-budget settings layer is ported.
- Row 47 removes retired GPT-5.4 Codex entries. The upstream test expectation for `gpt-6-astra` is not ported because that model is absent from Aira's openai-codex generator and catalog (pre-existing base-parity gap from the 0.85.1 sync).
- Rows 61/64 are the DeepSeek test-ID revert pair (net zero) and rows 66/80 the broken-test revert pair; neither side was ported.
- Model catalog rows were executed through `packages/ai/scripts/generate-models.ts`; provider data is gitignored and was hydrated, never hand-edited.
- Known deterministic failure: `model-registry.test.ts` stale `anthropic/claude-opus-4` expectations (pre-existing since Phase 1; fixed by a later audited upstream row outside this slice).

## Slice 3 (rows 67-99)

| # | Upstream SHA | Date | Subject | Disposition | Local SHA | Notes |
|---|---|---|---|---|---|---|
| 67 | `4819cc877e` | 2026-09-11 | docs(agent): add approved pico implementation handoff | SKIP | `` | [ARCH] Pi pico implementation handoff doc; architecture absent from Aira |
| 68 | `f467cf7068` | 2026-09-12 | feat(agent): add pico compile-time foundation | SKIP | `` | [ARCH] Pi pico storage/session work; absent from Aira |
| 69 | `7a2647f32a` | 2026-09-12 | docs(agent): define pico state tasks and tool boundaries | SKIP | `` | [ARCH] Pi pico storage/session work; absent from Aira |
| 70 | `d11c4b7281` | 2026-09-12 | docs(agent): simplify pico scheduling and core task model | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 71 | `1915b35a9b` | 2026-09-12 | feat(agent): refine pico core task capabilities | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 72 | `df484f2775` | 2026-09-12 | feat(agent): add pico memory storage foundation | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 73 | `99a3948c4c` | 2026-09-13 | docs(agent): define pico v2 kernel contract | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 74 | `51f3090790` | 2026-09-13 | feat(agent): align pico foundation with v2 contract | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 75 | `a9930d2857` | 2026-09-13 | docs(agent): correct pico v2 foundation contracts | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 76 | `fd3b009d9f` | 2026-09-13 | docs(agent): add pico3 view/events, plugins and hardening handoff | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 77 | `09b031600d` | 2026-09-13 | docs(agent): pico3 review decisions: revision, visibility, memos, waiting, reload | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 78 | `9b2aff2c5b` | 2026-09-13 | docs(agent): pico3: forbid AsyncLocalStorage; nested-line detection via Chord context key | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 79 | `0c7bb7c5c7` | 2026-09-14 | fix(ai): identify Responses error providers | DIRECT | `4521e7ccc` | Responses error provider identification; verbatim port, changelog kept by Aira |
| 80 | `ceea48f5d5` | 2026-09-14 | Revert "fix(ci): Fix a broken test" | SKIP | `` | [REV] completes the net-zero revert pair with row 66: ceea48f5d5 reverts 71dca871bc; neither side ported |
| 81 | `46b66c59af` | 2026-09-14 | feat(agent): add hardened pico3 kernel | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 82 | `850f83794d` | 2026-09-14 | Merge remote-tracking branch 'origin/main' into pico | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 83 | `53816d7dcc` | 2026-09-14 | chore: approve contributors from issue #9440 | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 84 | `f9bcd351dc` | 2026-09-14 | docs(ai): document Codex WebSocket cleanup | SKIP | `` | [CHG] changelog-only note |
| 85 | `56cd5989ea` | 2026-09-15 | docs(agent): replace obsolete Pico prototypes with Pico5 design | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 86 | `8a7b0c03df` | 2026-09-15 | fix(ai): price Bedrock one-hour cache writes | DIRECT | `909e13e88` | Bedrock 1h cache-write pricing; source verbatim. The new test hardcoded then-current models.dev regional prices; upstream corrected it at row 91 (also in this slice) to derive from model.cost |
| 87 | `ea7f84678c` | 2026-09-15 | Merge remote-tracking branch 'origin/main' into pico | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 88 | `c8e4a5a552` | 2026-09-15 | docs(agent): finalize Pico5 architecture and presentation | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 89 | `d7296c063b` | 2026-09-15 | feat(coding-agent): isolate documentation lift evals (#9635) | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 90 | `b02eef4186` | 2026-09-15 | docs(agent): specify Pico5 harness API | SKIP | `` | [ARCH] Pi pico runtime work; absent from Aira |
| 91 | `4c2d91339a` | 2026-09-15 | fix(coding-agent): export extension event hook types (#9642) | REIMPLEMENT | `b29c105b9` | [EXT] exports extension hook event/handler types from the package entry point; includes the Bedrock cost-test stabilization |
| 92 | `3349e1db18` | 2026-09-15 | fix(coding-agent): reject unverified local clipboard writes | REIMPLEMENT | `0ef749a0e` | [CLIP] Aira-native: OSC 52 fallback only for remote sessions; local unverified writes now fail. External clipboard dependency and clipboard-native.ts kept |
| 93 | `60e7e76bd7` | 2026-09-16 | fix(coding-agent): surface clipboard backend failures | REIMPLEMENT | `50666a065` | [CLIP] Aira-native platform guidance for clipboard failures (Termux/Wayland/X11/no display); no native refactor imported |
| 94 | `b03a367a4f` | 2026-09-16 | feat(coding-agent): allow configuring Anthropic fallback models | REIMPLEMENT | `0dc4072fa` | [CONFIG] models.json overrides can replace/disable allowedFallbackModels; schema port into Aira model-config |
| 95 | `9b791a4cc1` | 2026-09-16 | fix(coding-agent): avoid transcript scans for exact session IDs (#9601) | DIRECT | `a317f01f6` | SessionManager.findById header-only lookup; Aira shares the helpers, verbatim port, new header-only assertions pass |
| 96 | `6671c60476` | 2026-09-16 | fix(ai): send Baseten session affinity headers | REIMPLEMENT | `e0a8acd33` | [CATALOG] Baseten session affinity flag; generator-only change, data hydrated |
| 97 | `9e05370b29` | 2026-09-16 | Mid conversation system messages (#9548) | SKIP | `` | [ARCH] Phase 0B: Pi SystemMessage/TranscriptContext architecture skipped; not imported. Rows 104/121 follow this decision |
| 98 | `1247476e6d` | 2026-09-16 | fix(coding-agent): update eval prompt section markers | SKIP | `` | [EVAL] Pi eval prompt section markers; Aira evals remain smoke/extensions only |
| 99 | `aa50fe778a` | 2026-09-16 | fix(ai): derive Google thinking levels from models.dev | REIMPLEMENT | `9444a38ee` | [CATALOG] Google thinking levels derived from models.dev; mid-conversation effort machinery not imported (aligned with row 97 skip); generator is source of truth |

Slice 3 totals: DIRECT=3, REIMPLEMENT=6, SKIP=24, TOTAL=33

Cumulative totals rows 1-99: DIRECT=15, REIMPLEMENT=17, SKIP=67, TOTAL=99

### Slice 3 notes

- Row 80 is the matching revert of row 66 (`ceea48f5d5` reverts `71dca871bc`); neither side was ported.
- Row 86 was applied verbatim. Its test hardcoded models.dev regional prices that have since drifted; upstream corrected the test at row 91 (in-slice) to derive the expectation from `model.cost`, and Aira carries that correction.
- Clipboard rows 92/93 are Aira-native adaptations: OSC 52 is reserved for remote sessions and failures now carry platform guidance. The skipped `caf6dfe731` native/prebuild refactor was not resurrected.
- Row 97 keeps the Phase 0B SKIP for Pi SystemMessage/TranscriptContext; rows 104/121 follow.
- Row 99 dropped the mid-conversation effort machinery that upstream carries in the same generator region, aligned with the row 97 skip.
- gpt-6-astra parity note: no row in 67-99 modifies that model; the open note from Phase 2 stands.
- Known deterministic failure unchanged: `model-registry.test.ts` stale `anthropic/claude-opus-4` expectations (a later audited upstream row fixes them outside row 99).

## Slice 4 (rows 100-132, in progress)

Rows 100-116 below; rows 117-132 follow in the next update.

| # | Upstream SHA | Date | Subject | Disposition | Local SHA | Notes |
|---|---|---|---|---|---|---|
| 100 | `01528e2094` | 2026-09-16 | Merge remote-tracking branch 'origin/main' into pico | SKIP | `` | [MRG] merge commit; constituents accounted for in earlier slices |
| 101 | `bdee230f1e` | 2026-09-16 | feat(ai): refresh generated image model catalog | SKIP | `` | [GEN] generated image catalog only; Aira hydrates through scripts/generate-image-models.ts |
| 102 | `fde6d778f8` | 2026-09-16 | fix(coding-agent): toggle summary entries on click | SKIP | `` | [UI] approved execution-time correction (DIRECT -> SKIP): Pi component-level MouseRegion/TuiMouseEvent hit-testing (base commit 71026970a) was not carried into Aira TUI; low-level mouse parsing exists but no reusable hit-region ab |
| 103 | `509ee2bd0b` | 2026-09-16 | fix(coding-agent): fail closed on user bash hook errors (#9662) | REIMPLEMENT | `b038b49c1` | [EXT] user_bash hook failures are validated and fail closed; runner/types/interactive-mode ported with Aira runner conflict resolved |
| 104 | `e4c75a7322` | 2026-09-16 | fix(coding-agent): replace the system prompt when a handler forces it | SKIP | `` | [ARCH] Phase 0B: follow-up of the skipped mid-conversation SystemMessage/TranscriptContext model (44 references) |
| 105 | `16235fd935` | 2026-09-17 | fix(ai): avoid unsupported Gemini thinking levels | REIMPLEMENT | `8f2272462` | [AI] Gemini thinking levels resolve through each model supported levels; test adapted to Aira plain context (no Pi transcript normalization) |
| 106 | `1283afd0d0` | 2026-09-17 | fix(ai): preserve thinking replay through renamed Anthropic models | REIMPLEMENT | `9cade3b0d` | [AI] responseModel recorded for renamed/fallback Anthropic models so signed thinking replays; 3-way contamination from the skipped row 97 removed and hunks applied manually; no input_transformations import |
| 107 | `e5d18382a2` | 2026-09-17 | fix(ai): retry Cloudflare 520 responses | DIRECT | `5c7219ae8` | Cloudflare 520 retry; verbatim port |
| 108 | `7140838fdd` | 2026-09-17 | chore: approve contributors from issue #9645 | SKIP | `` | [SEC] security-sensitive CI contributor authorization; prior ledger REJECTED class |
| 109 | `2b04ce27fb` | 2026-09-17 | docs(agent): refine Pico5 plugin state API | SKIP | `` | [ARCH] Pi pico docs; architecture absent from Aira |
| 110 | `e98f287ee4` | 2026-09-17 | fix(ai): retry Azure peak-load capacity errors | DIRECT | `0d59b2972` | Azure peak-load retry; verbatim port |
| 111 | `42cd371ba4` | 2026-09-17 | feat(coding-agent): add TUI context footer eval (#9705) | SKIP | `` | [ARCH] Pi pico/durable runtime; absent from Aira |
| 112 | `729d5cb74d` | 2026-09-17 | docs(agent): finalize Pico5 specification set | SKIP | `` | [ARCH] Pi pico/durable runtime; absent from Aira |
| 113 | `5a3a03a7f5` | 2026-09-17 | fix(coding-agent): validate eval prompts from transcripts (#9706) | SKIP | `` | [EVAL] Pi documentation evals; Aira evals keep smoke/extensions only |
| 114 | `0e19ac1161` | 2026-09-17 | Merge remote-tracking branch 'origin/main' into pico | SKIP | `` | [ARCH] Pi pico/durable runtime; absent from Aira |
| 115 | `7e19507681` | 2026-09-17 | feat(coding-agent): add experimental micro agent | SKIP | `` | [ARCH] Pi pico/durable runtime; absent from Aira |
| 116 | `2c995acf44` | 2026-09-17 | feat(chord): replace delta tracker with operation log | SKIP | `` | [ARCH] Pi pico/durable runtime; absent from Aira |

Slice 4a totals (rows 100-116): DIRECT=2, REIMPLEMENT=3, SKIP=12, TOTAL=17

Pending: rows 117-132. Proposed corrections (awaiting approval):

- Row 117 `4658534986` REIMPLEMENT -> SKIP: rewrites the Anthropic thinking-drop notice, which exists in the Pi 0.85.1 base but was not carried into Aira's interactive mode; no `Anthropic dropped` code or diagnostics test exists in Aira history.
- Row 126 `13784598d2` REIMPLEMENT -> SKIP: same absent notice family (`maybeShowAssistantDiagnostics` / thinking_drop notices).

Aira-owned (non-upstream) branch commit on this slice: `008a7a77c` `fix(aira): preserve visible messages across context compaction`. It is not counted in upstream DIRECT/REIMPLEMENT totals.

