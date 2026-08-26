# Phase 5 — Native Intelligence: Report

> Status: complete (2026-08-27) | Commits listed at the end are part of this phase.
> Scope honored per the phase brief: a foundational, ambient, native
> intelligence service studied against the installed `pi-lens` and
> `pi-codeontime-code-intelligence` reference implementations, with explicit
> classification of what was adopted, adapted, deferred, and rejected.
> `engineering-loop` was not consulted and is not integrated.

## Reference study

### Installed reference implementations inspected

| Specimen | Location | Version |
| --- | --- | --- |
| pi-lens | `~/.pi/agent/npm/node_modules/pi-lens` | 4.1.2 (dist bundle + docs + skills + rules) |
| pi-codeontime-code-intelligence | `~/.pi/agent/npm/node_modules/pi-codeontime-code-intelligence` | 0.2.4 (dist/src TypeScript sources) |

Both were read as laboratory specimens only: no modifications, no runtime
dependency, no wrapping of their slash commands, no wholesale copying.
Aira's implementation is independently written after studying behavior and
architecture; the only deliberately mirrored ideas are the small ones
listed per module below (freshness kernel shape, path-heuristic test
counterparts, working-set boosts, bounded lazy LSP lifecycle, honesty
labels). No source was copied; both projects are MIT-licensed and no
license notice is required for the independently written code, which shares
no substantial text with either.

### pi-lens architecture findings

- **Extension entry/lifecycle**: one wrapper around host events
  (`session_start`, `tool_call`, `tool_result`, `turn_start/end`,
  `agent_end`, `agent_settled`, `session_shutdown`, `resources_discover`,
  `session_before_fork`) with a stale-ctx guard for replaced sessions;
  ~50 registered agent tools with a dynamic activate-as-needed subset.
- **LSP**: 45+ server definitions; discovery from PATH, project
  `node_modules`, and managed installs; a client pool with warm reuse,
  single-flight cooldowns, 240s idle eviction, per-server capability
  snapshots (position encoding, sync mode, push-only tiers), and a cascade
  lane that pulls diagnostics on reverse-dependency neighbors with a
  tier-aware wait policy.
- **Diagnostics**: unified findings stores (widget state, warning caches,
  project snapshot) behind one freshness kernel (mtime vs reference
  timestamp, 50ms drift tolerance, explicit `indeterminate`), dependency
  drift and past-EOF checks, and honesty labels (`stale`, `partial`,
  `cold`, `unconfirmed`) that prove absence is never rendered as clean.
- **Automatic behavior**: post-edit pipeline on `tool_result` (secrets,
  format, autofix, sync, lint, tests per file kind), turn-end findings
  injection, session-start guidance, nudges; read-before-edit guard;
  degradation ledger + telemetry; hard caps everywhere (6000 files,
  512KB/file, bounded caches, single-flight pools).
- **Discovery funnel**: `symbol_search` (BM25 word index) →
  `module_report` (outline) → `read_symbol`; ast-grep/tree-sitter
  structural runners across 35+ file kinds.

### pi-codeontime-code-intelligence architecture findings

- **Lifecycle**: `session_start` → repo identity + enablement + activation
  (DB, scheduler, file watcher, embedding service); `tool_result`
  (edit/write) → debounced post-edit review; `before_agent_start` →
  planning context pack (code chunks + learnings + hard rules) injected
  into the prompt; `input` → correction capture; `message_end` → review
  JSON capture; `session_shutdown` → teardown. Slash commands for review,
  doctor, indexing, learnings; five agent tools (impact, analyze-changes,
  search, record-learning, review-feedback).
- **Indexing**: better-sqlite3 + drizzle, full/incremental index in a
  spawned worker process (lock files, orphan reaping, stall reconciliation),
  chokidar watcher with debounce thresholds, bounded scanner (globs,
  size caps, generated-file detection), symbol-aware chunking.
- **Graph**: entities + relationships (imports resolved against the active
  path set, test counterparts by path heuristics, route/screen, same-
  feature), code relationships via referenced-name lookup.
- **Retrieval**: hybrid rank merging FTS5 (45%) + embeddings (55%),
  working-set boosts (current/visible/changed/counterpart files), ranking
  adjustments by query intent; learnings and machine rules layered on top.
- **Degradation**: FTS-only fallback when embeddings unavailable, freshness
  labels (`index state`, `embedding state`) on every injected pack,
  embedding providers behind an interface (local transformers /
  openai-compatible / disabled).

### Capability classification (native / adapt / defer / reject)

| Capability | Class | Note |
| --- | --- | --- |
| Project-scoped lazy LSP lifecycle | **Native** | per-session, lazy spawn, reuse, idle eviction, crash cooldown |
| Language-server discovery (PATH + node_modules) | **Native** | no managed installs (later phase) |
| Diagnostics ingestion + freshness kernel | **Native** | mtime-vs-collection kernel, indeterminate verdict, staleness-aware summaries |
| Automatic post-edit diagnostics | **Native** | tool lifecycle events → debounced sync → bounded wait → findings store |
| Definition / references / document symbols | **Native** | warm-only navigation (no cold spawn at prompt time) |
| Repository file index (languages/symbols/imports/tests) | **Native** | bounded, incremental, file-level |
| Imports / imported-by + source/test counterparts | **Native** | path heuristics mirroring the reference's rules |
| Git changed-file awareness | **Native** | porcelain v1 authoritatively parsed |
| Lexical discovery (likely files) | **Native** | identifier-token index (camelCase-aware); BM25 sophistication not needed |
| Ambient context injection at prompt time | **Native** | bounded pack, no-repeat guarantee, mode-weighted |
| Impact awareness (imported-by) | **Native** | REVIEW emphasis |
| Health snapshot + `/doctor` checks | **Native** | canonical state; `/status` stays restrained |
| Capability classification contract | **Native** | ADR-022 |
| Semantic embeddings / vector retrieval | **Defer** | lexical + structural + LSP suffice for the funnel; no network/model gate on local understanding; provider boundary reserved |
| SQLite persistence | **Defer** | JSON cache behind provider boundary; see Node 25 finding below |
| Structured code graph (entities, caller/callee, routes) | **Defer** | foundation is file-level by design |
| Chunking + retrieval of code bodies | **Defer** | model reads files itself; later phase if needed |
| File watchers (chokidar) | **Defer** | git status + session edits + on-demand rescans suffice |
| word-index BM25 / module_report outlines | **Adapt-later** | lexical piece adopted in simplified form; tree-sitter outlines need grammar machinery (deferred) |
| Read-before-edit guard | **Defer** | studied; belongs with edit safety, not intelligence |
| Formatting/autofix pipelines | **Defer** | Phase 6 execution territory |
| ast-grep/tree-sitter 35+ runner ecosystem | **Reject** | explicit phase scope; no compelling foundation need |
| Learnings, machine rules, correction capture | **Reject** | explicit phase scope |
| Review agents / autonomous review | **Reject** | Phase 8 verifier, not Phase 5 |
| Degradation ledger / telemetry dashboards | **Reject (simplified)** | health snapshot + degraded flag instead |
| Managed tool installs (npx/downloads) | **Defer** | bootstrap concerns |
| MCP server surface | **Reject** | later phases |

## Aira architecture

### Where the Aira boundary was placed

```text
src/aira/
├── capabilities.ts                          NEW: semantic capability classification (ADR-022)
├── intelligence/
│   ├── index.ts                             public surface
│   ├── activation.ts                        activation decisions from ProjectProfile
│   ├── coordinator.ts                       the service owner (activate/context/events/dispose)
│   ├── context.ts                           bounded ambient context selection (budget)
│   ├── findings.ts                          findings model + freshness kernel + store
│   ├── status.ts                            health snapshot shape
│   └── providers/
│       ├── index.ts                         provider surface (replaceable engines)
│       ├── live-code/
│       │   ├── registry.ts                  server definitions + PATH/node_modules discovery
│       │   ├── lsp-client.ts                minimal JSON-RPC LSP client (stdio)
│       │   └── index.ts                     LiveCodeProvider (pool, sync, diagnostics, nav, eviction)
│       └── repository/
│           ├── scanner.ts                   bounded walk + per-language parsing
│           ├── relationships.ts             imports/imported-by, counterparts, git changes, lexical index
│           ├── cache.ts                     JSON persistence under the Aira home
│           └── index.ts                     RepositoryProvider (lifecycle, working set, discover)
```

Host integration stays four narrow seams in `core/agent-session.ts`:

```text
constructor     → createAiraIntelligence(state, agent, {cacheDir}) + void activate()
prompt()        → providePromptContext(prompt) → custom message (string content, display:false)
agent events    → coordinator subscription (turn_start, tool_execution_start/end)
dispose()       → coordinator.dispose() (LSP shutdown, timers)
```

plus `state.intelligence` (canonical health snapshot, single writer: the
coordinator), `get airaSessionState` accessor, `/doctor` intelligence +
capabilities checks, and a `cwd` option on the test harness.

### Provider boundaries and lifecycle

- **Activation** (`activation.ts`): from the canonical `ProjectProfile`
  (ADR-021). No defensible project → inactive (no arbitrary-directory
  indexing). Low confidence → conservative: repository intelligence only,
  live-code not armed. Languages → served subset becomes the live-code
  candidate list; nothing spawns eagerly.
- **RepositoryProvider**: background bounded scan at session start (single
  flight, mtime/size reuse, per-file reindex on edit), cache under
  `<home>/agent/cache/intelligence/<root-hash>.json`, git changes via
  `status --porcelain -v1` (trim-free path parsing), lexical discovery.
- **LiveCodeProvider**: lazy per-language clients, launch override seam
  (tests inject a mock server), LRU open documents (didClose on eviction),
  idle eviction, crash cooldown with respawn, warm-only navigation.
- **FindingsStore**: path-keyed, atomic replace, turn tagging, caps,
  freshness refresh against file mtimes; summaries exclude stale findings.

### Ambient activation

When does intelligence do work?

| Signal | Behavior |
| --- | --- |
| Session construction | decide activation; arm providers (background scan) |
| `prompt()` (any mode) | one bounded context message; identical content never re-injected; orientation/availability deliver once |
| `tool_execution_end` (edit/write, success) | clear stale findings → note edit → debounced reindex + LSP diagnostics |
| `turn_start` | findings turn bookkeeping |
| Mode change | context pack weights: BUILD full funnel; PLAN read-only funnel; REVIEW diagnostics/changed/impact emphasis |
| Nothing relevant | no injection, no spawns, no scans beyond the initial bounded one |

### Context budget

`context.ts` implements the funnel with hard caps (defaults):
maxTotalChars 1600; 4 likely files; 6 changed files; 5 diagnostic paths ×
2 lines; 3 impact entries per file; sections drop in priority order under
the cap; stale findings are excluded; `hasSignal` + content hash prevent
repeat injections. Prompt-time work is synchronous over in-memory
structures only.

### Persistence/indexing decision and the Node 25 / better-sqlite3 finding

Documented finding: `pi-codeontime-code-intelligence` pulls
`better-sqlite3@11.10.0`, which has no Node 25 / macOS arm64 prebuilt
binary; npm falls back to node-gyp, which fails against the V8 headers.
Architectural conclusions:

- **Aira does not add any native addon in Phase 5.** The file-level index
  has no query workload that justifies one; a JSON cache keyed by file
  mtime/size behind `repository/cache.ts` (under the Aira home, never the
  workspace) satisfies "bounded, incremental where practical, project-
  scoped, cacheable, easy to invalidate, cheap at startup".
- Node 25's built-in `node:sqlite` (zero-dependency, FTS5-capable) was
  verified working on the baseline; it is the documented upgrade path
  behind the same cache module if a later phase needs SQL. This keeps
  bootstrap robust: Aira's optional intelligence subsystem can never
  block install/launch on a native compile.
- Storage stays behind a provider boundary; embeddings stay behind an
  interface if ever introduced.

### Mode integration

- **BUILD**: full intelligence; automatic post-edit diagnostics;
  impact-aware context.
- **PLAN**: host-enforced read-only remains; intelligence ops are all
  read-only by construction (caches live outside the workspace); context
  injection allowed; the coordinator additionally skips post-edit LSP runs
  in PLAN (second gate). Symbol/definition/reference/diagnostics/
  repository discovery all remain available.
- **REVIEW**: inspection emphasis — diagnostics, changed files, impact
  (imported-by), counterparts; still not the Phase 8 verifier.

### Graceful degradation (verified by tests)

- no project → service inactive, sessions fully usable;
- language not in registry → no client; language in registry but no
  server on PATH → no spawn, plain search;
- server crashes at handshake → degraded status, crash count, cooldown,
  no throw into the host;
- unreadable root / failed scan → degraded repository with partial index;
- cache write failure → best-effort, in-memory continues;
- post-edit pipeline in PLAN → skipped;
- everything surfaces through `/doctor` (`intelligence` check) and
  `state.intelligence`.

## Behavior

What now happens automatically during ordinary coding:

```text
session start (project cwd)
  → project scanned in background (symbols/imports/tests/changes)
  → /doctor shows intelligence health
prompt
  → compact ambient context: project, likely files, changed files,
    diagnostics (never stale), REVIEW impact
edit/write tool call
  → repository reindex + language-server diagnostics, debounced
next prompt → fresh diagnostics summary injected (repair/continue)
missing language server → nothing breaks; plain Pi search/read behavior
```

What remains explicit: `/doctor` health, `/mode`/`/status` (restrained),
slash commands generally. No new intelligence slash commands were added;
no model-facing intelligence tools were added — Phase 5 delivers the
service behavior natively, and explicit tools can be layered later
behind the same coordinator.

## Verification

### Tests added

- `test/aira/capabilities.test.ts` — classification contract (7 tests).
- `test/aira/intelligence/findings.test.ts` — freshness kernel, store
  semantics, summaries (12).
- `test/aira/intelligence/repository.test.ts` — scanner, relationships,
  provider, git changes, cache round-trip (17).
- `test/aira/intelligence/live-code.test.ts` — registry/discovery,
  position conversion, mock-server diagnostics lifecycle, warm navigation,
  crash degradation, idle eviction (12).
- `test/aira/intelligence/coordinator.test.ts` — activation, context
  selection (incl. REVIEW emphasis/impact), coordinator lifecycle,
  post-edit pipeline, PLAN gating, no-project inertness, dispose (14).
- `test/aira/intelligence/host-integration.test.ts` — real AgentSession
  path: arming, ambient injection, post-edit pipeline with degradation,
  PLAN read-only, no-project usability (5).
- Updated: doctor tests (intelligence + capabilities checks), harness
  (`cwd` option).

### Focused results

```text
vitest --run test/aira                 → 19 files, 163 passed, 0 failed
vitest --run test/suite test/aira      → 95 files, 423 passed, 0 failed
tsgo --noEmit (package)                → PASS
```

### Repo-wide checks

`npm run check` (biome `--error-on-warnings` whole repo, pinned-deps,
ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke) ran
on every commit via the pre-commit hook: PASS on all Phase 5 commits
including the final docs commit.

Full non-e2e suite (`./test.sh`, isolated HOME): coding-agent **254 passed /
6 skipped; 2139 passed / 50 skipped (no failures)**; all other workspaces
passed (session-backends sqlite-node 87, agent 147, tui 50, client 15,
server 23, evals 36, scripts 6). The one failure is the documented
pre-existing environmental case, unchanged from Phases 2–4:
`packages/ai zai-coding-plan-models` (machine-hydrated catalog data gives
`glm-5.3` a price the upstream test expects to be zero; zero Phase 5 diff in
`packages/ai`). The known footer reftable timing flake passed this run. No
new failures were introduced; none were silently fixed.

### Real-language-server verification (this machine)

An ad-hoc end-to-end smoke (temp Python project, real `pyright-langserver`
from PATH, seed time of Phase 5): session activation → repository ready →
write tool event on a syntax-broken file → post-edit diagnostics ingest
(`findings.errors = 1`, live-code `ready`, zero crashes) → next prompt
context contains the `Diagnostics` summary. This is the exact
objective → project → likely files → edit → diagnostics → context loop of
the phase brief, run against a real language server.

One protocol finding surfaced during that verification and is committed:
pyright (vscode-languageserver) suppresses `textDocument/publishDiagnostics`
when the client advertises the `workspace.workspaceFolders` initialize
capability; Aira does not advertise it (the `workspaceFolders` params array
is sufficient) and the finding is documented in `lsp-client.ts`.

## Compatibility concerns

- No extension API, slash-command, keybinding, or package surface changed;
  the npm package still ships both `aira` and `pi` bins.
- Unknown/third-party tools remain PLAN-permissive (documented ADR-022
  rule) — compatibility behavior is identical to Phase 3, now stated as a
  classification rule.
- The ambient context injection uses the existing custom-message channel
  (`display:false`), the same one extensions use; nothing new is required
  from packages.
- Aira does not depend on pi-lens or pi-codeontime-code-intelligence.

## Architectural decisions that became ADRs

- **ADR-022 — Native capability classification is the semantic contract
  for host policy; unknown capabilities stay PLAN-permissive**
  (vocabulary, PLAN gate derivation, extension-tool compatibility rule).
- **ADR-023 — Aira intelligence is a native service: activation from the
  canonical project profile, bounded providers, ambient context, honest
  degradation**
  (service model, provider boundaries, persistence decision with the
  Node 25/better-sqlite3 evidence, ambient lifecycle, mode integration,
  health surfacing, degradation contract, reference-status disclosure).

## Local Git commits created (nothing pushed)

```text
55844c477 feat(aira): add semantic capability classification contract
1af254789 feat(aira): add evidence findings model with freshness contract
042373aa5 feat(aira): add repository intelligence provider
339f748ef feat(aira): add live-code provider with minimal LSP client
e3c75b5fc feat(aira): add intelligence coordinator with ambient activation and context
cfe97f574 fix(aira): drop workspaceFolders capability flag that suppressed pyright push diagnostics
<docs commit> docs: Phase 5 report, ADR-022/023, changelog, architecture updates
```

## Final `git status`

Clean working tree. `main` = docs commit at the end of this phase; ahead
of `upstream/main`, behind by 29 (baseline divergence). Only remote:
`upstream` (Pi). No `origin`, nothing pushed, nothing published.

## Stopping point / next phase

Stopped after Phase 5 per roadmap discipline. Next: **Phase 6 — Execution
Runtime** (process manager, log capture, project-aware tests, execution
events). No Phase 6 functionality has leaked in; `engineering-loop` was
not consulted or integrated.
