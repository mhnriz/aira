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

Rows 100-116 below; rows 117-132 in the slice 4b table at the end of this section.

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

## Slice 4b (rows 117-132)

| # | Upstream SHA | Date | Subject | Disposition | Local SHA | Notes |
|---|---|---|---|---|---|---|
| 117 | `4658534986` | 2026-09-17 | fix(coding-agent): shorten Anthropic thinking drop notices | SKIP | `` | [UI / DEFERRED_PROVIDER_FEATURE_FOLLOWUP] follow-up UI rewrite of the thinking-drop notice introduced by `4e69b0c28`; the managed mid-conversation-effort / thinking-binding base feature is not active in Aira (see correction below) |
| 118 | `3955b27a1d` | 2026-09-17 | fix(ai): preserve Vercel AI Gateway unsigned thinking | REIMPLEMENT | `14c952f9e` | [CATALOG] every Vercel AI Gateway model tagged `allowEmptySignature`; generator + regression test; data hydrated through generate-models.ts |
| 119 | `a8b3dd1998` | 2026-09-17 | fix(coding-agent): fail signal-terminated shell commands | DIRECT | `5b2dc1ea8` | signal-terminated commands exit non-zero; 3-way merge conflicts only in changelog |
| 120 | `7811394112` | 2026-09-17 | docs(coding-agent): update changelog | SKIP | `` | [CHG] changelog-only note |
| 121 | `16292398af` | 2026-09-17 | fix(coding-agent): send forced system prompts without recording them | SKIP | `` | [ARCH] Phase 0B row-97 follow-up: Pi forced SystemMessage/TranscriptContext plumbing absent from Aira; previously approved |
| 122 | `46c9de402b` | 2026-09-17 | feat(coding-agent): add event handler unsubscribe (#9630) | DIRECT | `e0b8a623a` | extension `on()` returns an unsubscribe function; all 29 event signatures converted; 3-way merge conflicts only in changelog |
| 123 | `c4289b20eb` | 2026-09-18 | fix(chord): keep tracked paths correct across structural mutation | SKIP | `` | [ARCH] Pi chord/durable runtime absent from Aira |
| 124 | `328926b30e` | 2026-09-18 | docs(chord): describe tracker ownership and aliasing as they behave | SKIP | `` | [ARCH] Pi chord/durable runtime absent from Aira |
| 125 | `ea9e093516` | 2026-09-18 | fix(ai): update tests for current model catalogs | REIMPLEMENT | `0700bc9a4` | [CATALOG] Aira already matched the post-commit Mistral lookup and z.ai effort metadata through earlier catalog rows; added the missing international z.ai GLM-5.2 highspeed zero-cost assertion |
| 126 | `13784598d2` | 2026-09-18 | fix(coding-agent): suppress repeated Anthropic thinking drop notices | SKIP | `` | [UI / DEFERRED_PROVIDER_FEATURE_FOLLOWUP] same family as row 117; no active behavior to de-duplicate |
| 127 | `bb0f4aa602` | 2026-09-18 | fix(ai): preserve DeepSeek V4 effort metadata | REIMPLEMENT | `80080e38d` | [CATALOG] guard the hardcoded DeepSeek V4 map behind `thinkingLevelMap === undefined` so OpenRouter reasoning metadata and opencode-go models.dev effort options survive; generator + tests; data hydrated |
| 128 | `661619e872` | 2026-09-18 | fix(ai): scope bodyless overflow errors to Cerebras | DIRECT | `df6be81ec` | Cerebras provider guard on the bodyless-overflow pattern; source blob identical, changelog kept by Aira |
| 129 | `fe219d7f8d` | 2026-09-18 | feat(coding-agent): format bash tool durations to support hours, minutes, seconds (#9742) | REIMPLEMENT | `85c1573ba` | [REL] `formatDuration` ported into Aira's `core/tools/bash.ts`; test exercises the expanded ToolExecutionComponent |
| 130 | `cf8d5fac30` | 2026-09-18 | feat(agent): add Pico storage foundation | SKIP | `` | [ARCH] Pi pico storage; absent from Aira |
| 131 | `eed5263cdd` | 2026-09-18 | Merge remote-tracking branch 'origin/main' into HEAD | SKIP | `` | [MRG] merge commit; constituents accounted for |
| 132 | `5901446094` | 2026-09-18 | fix(tui): reduce fuzzy search latency | DIRECT | `35dbc56ff` | native `indexOf` fuzzy scan; verbatim port, changelog kept by Aira |

Slice 4b totals (rows 117-132): DIRECT=4, REIMPLEMENT=4, SKIP=8, TOTAL=16

Slice 4 combined totals (rows 100-132): DIRECT=6, REIMPLEMENT=7, SKIP=20, TOTAL=33

Cumulative totals rows 1-132: DIRECT=21, REIMPLEMENT=24, SKIP=87, TOTAL=132

### Slice 4b notes

- Rows 117/126 approved correction: REIMPLEMENT -> SKIP, class
  `UI / DEFERRED_PROVIDER_FEATURE_FOLLOWUP`. Do not record the reason as
  "Aira does not contain the notice"; the authoritative behavioral reason is
  that the notices are follow-up fixes to the Anthropic managed
  mid-conversation-effort / thinking-binding behavior introduced upstream by
  `4e69b0c28` (with follow-up `0fdec07ba`), and that base feature is not
  active in Aira. Aira does not define `supportsMidConvoEffort`, does not
  generate that compatibility flag for Anthropic models, does not use the
  Anthropic beta messages API, does not send thinking `block_binding` with
  `prefix_mismatch_behavior: "drop_block"`, does not request the
  `thinking-binding-controls` beta, does not capture Anthropic
  `input_transformations`, does not emit `thinking_dropped` diagnostics,
  does not persist `providerThinkingLevel`, and does not consume those
  diagnostics in the coding-agent UI. The specific server-side
  drop-and-report condition handled by rows 117/126 therefore cannot be
  intentionally triggered by Aira's current Anthropic request path. Aira
  instead retains its existing client-side signed-thinking mismatch
  avoidance behavior. Rows 117/126 have no active Aira behavior to modify;
  no implementation commits were created for either row.

### Historical clarification: `4e69b0c28`

The previous Pi 0.85.1 sync summarized `4e69b0c28`
(`feat(ai): preserve Anthropic per-turn thinking effort`) under
`SUPERSEDED_BY_AIRA`. That label overstates actual behavioral parity. The
more accurate interpretation is a DEFERRED provider/settings slice: Aira
owns related reasoning/mismatch behavior, but the upstream
`supportsMidConvoEffort` / Anthropic thinking-binding / `thinking_dropped`
diagnostic path was NOT ported, and the diagnostic sub-feature was not
separately tracked as a parity gap. This clarification is recorded only in
this ledger; git history and the Phase 14 preparation document are not
rewritten.

### Future reference: Anthropic managed mid-conversation effort family

`4e69b0c28`, `0fdec07ba`, `4658534986`, `13784598d2`.

If Aira later adopts Anthropic managed mid-conversation effort, evaluate the
family together rather than independently porting the two UI follow-ups. The
feature can be validated without live Anthropic API spend using the existing
fake-client/SSE fixture infrastructure in
`packages/ai/test/anthropic-sse-parsing.test.ts`. Do not implement that
feature during the current Pi upsync.

Aira-owned (non-upstream) branch commit on this slice: `008a7a77c` `fix(aira): preserve visible messages across context compaction`. It is not counted in upstream DIRECT/REIMPLEMENT totals.

## Slice 5 (rows 133-165)

| # | Upstream SHA | Date | Subject | Disposition | Local SHA | Notes |
|---|---|---|---|---|---|---|
| 133 | `8bdcd4498a` | 2026-09-18 | fix(coding-agent): compact oversized trailing tool results | REIMPLEMENT | `3d7a97907` | [REL] findCutPoint falls back to the latest valid cut point before oversized trailing tool results; Aira suite test rebased on its #8133 regression shape; see reconciliation below |
| 134 | `0801601621` | 2026-09-18 | feat(durable): move Pico into dedicated package | SKIP | `` | [ARCH] Pi durable/Pico package absent from Aira |
| 135 | `cf33309117` | 2026-09-18 | Merge remote-tracking branch 'origin/main' | SKIP | `` | [MRG] merge commit; constituents are rows 132/133, already processed |
| 136 | `b5ef419d5b` | 2026-09-18 | docs(agent): restore non-Pico5 documentation | SKIP | `` | [ARCH] Pi durable/Pico package absent from Aira |
| 137 | `1e39862f67` | 2026-09-18 | fix(coding-agent): detect llama.cpp chat-template thinking | REIMPLEMENT | `d1a2b03ab` | [REL] loaded models are probed via /props for enable_thinking; Aira's llama provider has no router-autoload presets, so LlamaServerProps carries only chat_template |
| 138 | `c1263aa113` | 2026-09-18 | fix: clean up delta lint diagnostics | SKIP | `` | [ARCH] Pi delta/durable tooling absent from Aira |
| 139 | `59eb4c393c` | 2026-09-18 | fix(coding-agent): clarify copy shortcut description (#9745) | DIRECT | `e979a28b6` | source blobs applied verbatim |
| 140 | `e4ce7b449f` | 2026-09-18 | fix(ai): update Kimi model catalog source | REIMPLEMENT | `` | [CATALOG] zero delta: Aira's generator already reads `kimi-code-plan-global` after earlier catalog rows; no commit |
| 141 | `a16ccd9be8` | 2026-09-18 | feat(durable): refine record and query contracts | SKIP | `` | [ARCH] Pi durable package absent from Aira |
| 142 | `0db5659249` | 2026-09-18 | fix(durable): index memory storage queries | SKIP | `` | [ARCH] Pi durable package absent from Aira |
| 143 | `734ab3434f` | 2026-09-18 | Merge remote-tracking branch 'origin/main' into HEAD | SKIP | `` | [MRG] merge commit; constituents are rows 137/139, already processed |
| 144 | `e80cf14011` | 2026-09-19 | docs(durable): simplify document runtime contracts | SKIP | `` | [ARCH] Pi durable package absent from Aira |
| 145 | `58541ee721` | 2026-09-18 | fix: reduce delta proxy retention and compact cloned objects | SKIP | `` | [ARCH] Pi delta package absent from Aira |
| 146 | `36b60d2e89` | 2026-09-19 | fix: clean up delta test lint diagnostics | SKIP | `` | [ARCH] Pi delta package absent from Aira |
| 147 | `3c75b27479` | 2026-09-19 | feat(coding-agent): add bug reporting | SKIP | `` | [ARCH] Pi Radius bug-reporting backend absent from Aira |
| 148 | `de2de549bc` | 2026-09-19 | fix(coding-agent): close compaction cancellation races | REIMPLEMENT | `9891ad439` | [REL] abort finalizes retry state, auth/summarization observe the signal, extension cancels emit cancellation, auto-compaction owns its abort controller; Aira keeps its `_systemPromptOverride`/`_activeRecoveryHint` reset |
| 149 | `4d38031fbd` | 2026-09-19 | feat(ai): ship Radius model catalog | REIMPLEMENT | `f79584589` | [CATALOG] public radius.pi.dev catalog as a built-in provider overlay; generated catalogs regenerated through Aira's generator |
| 150 | `eba619879c` | 2026-09-19 | docs: audit unreleased changelogs | SKIP | `` | [REL] upstream changelog audit; Aira maintains its own changelogs |
| 151 | `7d5eb0ee3b` | 2026-09-19 | fix(ai): mock Radius in model generation tests | DIRECT | `0b2ba18f8` | **corrected from SKIP**: Aira gained the target test file in an earlier slice, and row 149 made it fail 4/4; one-line Radius mock applies verbatim |
| 152 | `c596d09d9c` | 2026-09-19 | feat(coding-agent): add prompt cache warming (#9668) | REIMPLEMENT | `7fb71ab6f` | [REL] cache-warmer module, settings mode, usage accounting, interactive status, extension event, model promptCache metadata; Aira adaptations below |
| 153 | `bfa6862400` | 2026-09-20 | fix(tui): handle CJK punctuation in file autocomplete (#9746) | REIMPLEMENT | `f8f98c039` | CJK punctuation treated as word separators; editor.test.ts keeps Aira's node:test beforeEach/afterEach imports |
| 154 | `40c256cccb` | 2026-09-19 | feat(coding-agent): defer extension loader dependencies | REIMPLEMENT | `a9fd8c419` | bundled virtual modules extracted; jiti loaded lazily; Aira keeps its local isBundledNode declaration because config.ts does not export it |
| 155 | `fa0e1f48ac` | 2026-09-19 | fix(tui): improve LaTeX compatibility and layouts | DIRECT | `d94ed302b` | changelog conflict only, Aira CHANGELOG kept |
| 156 | `b7f7881949` | 2026-09-19 | fix(coding-agent): await terminal remote prompt event | SKIP | `` | [REL] target `src/experimental/client.ts` absent from Aira |
| 157 | `d7951ec362` | 2026-09-20 | fix(tui): rank skill autocomplete by bare name (#9120) | DIRECT | `a15df0c60` | clean application |
| 158 | `803f0e906d` | 2026-09-20 | fix(tui): preserve fullscreen images in WezTerm | DIRECT | `90ea74a9f` | changelog conflict only, Aira CHANGELOG kept |
| 159 | `21b8cc1a4b` | 2026-09-20 | fix(coding-agent): ignore stale tool image conversions (#8743) | REIMPLEMENT | `0a2b5f835` | stale async conversions guarded; Aira test fixture omits the unused TuiMouseEvent import |
| 160 | `dfbf793b78` | 2026-09-20 | feat(coding-agent): load session picker progressively | DIRECT | `0b92b733c` | changelog conflict only; source auto-merged cleanly |
| 161 | `dd01f5b240` | 2026-09-20 | fix(coding-agent): speed up recent session discovery | DIRECT | `f611219a2` | clean application |
| 162 | `12032deb70` | 2026-09-20 | docs: complete unreleased changelog audit | SKIP | `` | [REL] changelog-only; Aira maintains its own changelogs |
| 163 | `ecac0a9c4e` | 2026-09-20 | Release v0.86.0 | SKIP | `` | [ARCH] upstream release bump for packages absent from Aira and Aira-owned versioning |
| 164 | `50d766cba2` | 2026-09-20 | Add [Unreleased] section for next cycle | SKIP | `` | [ARCH] companion to row 163; Aira maintains its own changelogs |
| 165 | `d1230ea200` | 2026-09-20 | fix(coding-agent): preserve multiline bug descriptions | SKIP | `` | [ARCH] part of the Pi bug-reporting feature absent from Aira (see row 147) |

Slice 5 totals (rows 133-165): DIRECT=7, REIMPLEMENT=9, SKIP=17, TOTAL=33

Cumulative totals rows 1-165: DIRECT=28, REIMPLEMENT=33, SKIP=104, TOTAL=165

### Slice 5 notes

#### Row 133 compaction reconciliation against `008a7a77c`

- Upstream behavior: `findCutPoint` no longer leaves the cut at the first
  message when trailing tool results alone exceed `keepRecentTokens`; it falls
  back to the latest valid cut point so the assistant tool call preceding the
  oversized results is kept.
- Aira fitness: `008a7a77c` protects visible messages in the transient
  provider projection (`compactAiraModelContext`); row 133 changes only the
  session-summarization cut in `core/compaction/compaction.ts`. It does not
  touch `src/aira/context-compaction.ts`, the provider projection seam, or
  canonical SessionManager writes, and the projection re-applies its
  active-turn, latest-completed-assistant, and recent-window protection to the
  post-compaction canonical entries.
- Tool-result compaction and thinking replay are untouched. Split-turn
  prefixes remain standard upstream behavior and were already reachable for
  non-fallback cuts; row 133 only makes the fallback choose the latest valid
  cut point.
- The four Aira-owned projection regressions (active-turn report verbatim,
  latest completed assistant survives, tool results still compact, canonical
  history unchanged) remain green; `aira/context-compaction.test.ts` and
  `context-compaction-session.test.ts` pass after the change.

#### Row 151 disposition correction (approved)

SKIP -> DIRECT. The approved rationale ("all conflict targets absent") was
stale: `packages/ai/test/fireworks-model-generation.test.ts` exists in Aira
and, after row 149, failed 4/4 without the Radius fetch mock. The one-line
upstream change applies verbatim; committed with upstream metadata.

#### Row 140 zero-delta note

Aira's generator already reads `data["kimi-code-plan-global"]` from earlier
catalog rows, so row 140 required no change and produced no commit.

#### Row 152 Aira adaptations

- `cache-warmer.ts` resolves the `PI_CACHE_RETENTION` env override locally
  because the narrow `@earendil-works/pi-ai/utils/*` package export was part
  of the intentionally skipped `5507d76` import-topology work.
- `cache-warmer.test.ts` passes a plain `Context` instead of
  `normalizeContext` because Aira does not carry the skipped
  TranscriptContext/SystemMessage family.
- `settings-manager.test.ts` writes project settings under `.aira`.
- `packages/server/src/protocol.ts` (Aira-owned) accounts for
  `Model.promptCache` in its exact-key assertion.
- Provider data was hydrated through the generator; Aira CHANGELOGs kept.

#### Aira-owned repair during slice 5

`fix(coding-agent): restore Aira session disposal seams after the row 148 merge`
(local `82af7a77e`, not counted in upstream totals). The row 148 cherry-pick's
3-way merge silently replaced Aira's `dispose()` seam block (execution,
browser, verification, orchestration, goal, interaction, permissions, tasks,
intelligence) with upstream's shorter dispose. The Aira host-integration tests
(`test/aira/execution/host-integration.test.ts`,
`test/aira/orchestration/host-integration.test.ts`,
`test/aira/verification/host-integration.test.ts`) caught it during final
validation; the block was restored verbatim. This is the same 3-way-context
failure class as the row-106 incident: every staged diff in slice 5 was
inspected, but this hunk was a deletion inside a function that both sides
changed. `008a7a77c` remains separately attributable.

A second Aira-owned follow-up, `b3b53f028`
`fix(coding-agent): make the compaction threshold assertion race-free`,
adjusts the row 133 suite assertion: Aira can follow the threshold compaction
with a silent-overflow compaction once the resumed request exceeds the faux
model window, which raced the last-event assertion under full-suite load. The
assertion now requires a threshold compaction event while keeping every row
133 behavior assertion.

#### Known baseline

The three `model-registry.test.ts` failures for stale
`anthropic/claude-opus-4` expectations remain after row 165; no upstream row
in 133-165 fixes them. Row 152's new prompt-cache catalog assertion passes
after hydration and does not change that baseline.

