# Aira Roadmap

This roadmap deliberately builds the product from the host outward. Do not start with autonomous goals or a large agent swarm.

Every phase should finish in a working state and receive one or more **local Git commits** before proceeding.

```text
baseline
  ↓
Aira core seam
  ↓
native identity/config
  ↓
native modes + UX
  ↓
project awareness
  ↓
intelligence
  ↓
execution
  ↓
browser
  ↓
verification
  ↓
delegation
  ↓
durable autonomy
  ↓
compaction/knowledge
  ↓
policy hardening
  ↓
distribution
```

## Phase 0 — Fork and Baseline

### Goal

Establish a clean Pi-derived Aira repository before behavioral changes.

### Work

- clone/fork the Pi source;
- configure `origin` for Aira;
- configure `upstream` for Pi;
- record exact upstream commit/version;
- install dependencies;
- run upstream build, tests, lint/type checks;
- document any pre-existing failures;
- create an Aira development branch if desired;
- make the first local baseline commit/tag.

### Exit criteria

- clean working tree;
- upstream baseline builds;
- tests are understood;
- upstream remote is configured;
- Aira has a known reproducible starting commit.

### Git checkpoint

Example:

```text
chore: establish Aira upstream baseline
```

Do not push merely because the checkpoint exists. Local commits are expected.

---

## Phase 1 — Aira Core Seam

### Goal

Create a narrow native integration point without rewriting Pi internals everywhere.

### Work

- create isolated Aira module boundary;
- add canonical `AiraSessionState`;
- bridge relevant host lifecycle events into Aira;
- introduce feature flags if useful;
- implement minimal `/aira status`;
- add state-machine tests;
- ensure default behavior remains equivalent to baseline when Aira features are disabled.

### Exit criteria

- Aira subsystem loads natively;
- canonical state exists;
- host lifecycle reaches Aira through explicit seams;
- upstream behavior is not broadly patched.

### Git checkpoints

```text
feat(core): add native Aira runtime seam
feat(core): add canonical Aira session state
test(core): cover Aira state transitions
```

---

## Phase 2 — Native Identity and `~/.aira/`

### Goal

Make Aira its own product.

### Work

- canonical executable becomes `aira`;
- introduce Aira product metadata/versioning;
- establish `~/.aira/`;
- move Aira settings, sessions, cache, extensions, skills, themes, agents, and logs to Aira paths;
- implement path helpers rather than scattering literals;
- design optional Pi config migration/import;
- ensure normal operation has no dependency on `~/.pi/`.

### Exit criteria

- `aira` launches;
- a clean machine creates only the intended Aira home;
- path tests cover major resources;
- Pi migration is optional and explicit.

---

## Phase 3 — Native Modes and UX

### Goal

Make the harness visibly and behaviorally Aira.

### Work

- absorb/adapt useful `pi-polished-ui` behavior;
- native Aira header/footer/status;
- BUILD / PLAN / REVIEW;
- `Shift+Tab` cycle;
- safely move thinking/effort shortcut if required;
- enforce PLAN read-only at host/policy level;
- mode-aware tool availability;
- keybinding conflict audit;
- initial `/aira doctor`.

### Exit criteria

- mode transitions are immediate and deterministic;
- PLAN cannot modify the workspace;
- UI always reflects canonical mode;
- unrelated custom keybindings survive.

---

## Phase 4 — Project Awareness

### Goal

Aira understands the workspace before invoking expensive capabilities.

### Work

- Git-root detection;
- manifest/build-file detection;
- language/framework/package-manager detection;
- test/build/dev command discovery;
- browser-relevance heuristic;
- project confidence;
- workspace-boundary safeguards.

### Exit criteria

- representative Python, Node, .NET, C/C++, and mixed repositories classify sensibly;
- arbitrary home directories do not become giant projects;
- project profile is visible through diagnostics/status.

---

## Phase 5 — Intelligence

### Goal

Give Aira automatic repository and live-code understanding.

### Work

- capability provider abstraction;
- Lens integration/adapter spike;
- Code Intelligence integration/adapter spike;
- health/availability reporting;
- relevant-context retrieval;
- automatic post-edit diagnostics;
- normalize findings into supervision;
- suppress duplicate UI/noise;
- degrade cleanly if an optional provider is unavailable.

### Exit criteria

- Aira retrieves relevant repo context without manual slash commands;
- edits trigger usable diagnostic feedback;
- specialist engines do not own Aira's UX;
- provider replacement is architecturally possible.

---

## Phase 6 — Execution Runtime

### Goal

Aira can operate the software it edits.

### Work

- process manager;
- foreground/background adaptation;
- log capture;
- process reuse/restart;
- project-aware tests;
- build/type checks;
- execution events;
- basic checkpoint metadata.

### Exit criteria

- Aira can keep a development server running while continuing work;
- logs are accessible internally;
- targeted vs full verification is distinguishable;
- failures enter supervision coherently.

### Status

✅ done 2026-08-28 — [PHASE_6_EXECUTION_RUNTIME.md](phases/PHASE_6_EXECUTION_RUNTIME.md)

---

## Phase 7 — Browser Runtime

### Goal

Aira can verify browser-based applications.

### Work

- `BrowserProvider` abstraction;
- select CDP/Playwright implementation after spike;
- isolated Aira browser profile;
- navigation/interactions;
- DOM/accessibility-tree inspection;
- console;
- network;
- screenshots;
- waits;
- local application verification;
- explicit boundary for personal signed-in browsers.

### Exit criteria

- Aira can launch/reuse a local app and verify an interaction;
- runtime console/network failures can affect completion;
- personal browser state is never used implicitly.

---

## Phase 8 — Independent Verification

### Goal

Completion requires evidence rather than builder confidence.

### Work

- Verifier contract;
- fresh-context verification;
- requirement checklist;
- evidence bundle from diagnostics/tests/browser;
- PASS / FAIL / INCONCLUSIVE;
- bounded repair transition;
- scope-drift checks.

### Exit criteria

- non-trivial implementation is independently reviewed;
- failed verification can re-enter BUILD safely;
- inconclusive results remain explicit.

---

## Phase 9 — Task Graph and Delegation

### Goal

Support complex tasks without making simple tasks expensive.

### Work

- root-owned task graph;
- Scout;
- Researcher;
- subagent compatibility/provider;
- assignment/dependencies;
- concurrency bounds;
- delegation heuristics;
- optional model routing.

### Exit criteria

- complex tasks can decompose and parallelize;
- trivial tasks remain single-agent;
- child agents cannot create competing canonical task state.

---

## Phase 10 — Durable Autonomous Work

### Goal

Support long-running engineering objectives.

### Work

- durable objective;
- complexity-based promotion;
- bounded execution rounds;
- completion-boundary verifier;
- stop/resume;
- checkpoint/rewind;
- supervision integration;
- ownership isolation between sessions.

### Exit criteria

- a complex objective survives multiple rounds;
- failed verification restarts execution safely;
- unrelated prompts do not hijack an active durable task.

---

## Phase 11 — Compaction and Knowledge

### Goal

Maintain engineering continuity over long sessions.

### Work

- Aira compaction checkpoint;
- restore objective/plan/task/process/finding state;
- preserve working/reference files;
- introduce minimal project knowledge;
- define integration strategy for durable repo learnings.

### Exit criteria

- compaction does not lose engineering state;
- repository code is re-retrieved rather than bloating checkpoints;
- knowledge injection remains bounded.

---

## Phase 12 — Policy, Hooks, and Trust

### Goal

Harden autonomy for daily use.

### Work

- allow/ask/deny policy;
- workspace boundaries;
- trusted-project mechanism;
- project-local settings restrictions;
- Aira hook contract;
- exact-hash hook trust;
- explicit high-autonomy mode;
- security tests.

### Exit criteria

- a repository cannot self-grant privileges;
- destructive/out-of-scope actions are gated;
- changed hooks lose trust automatically.

---

## Phase 13 — Pi Compatibility Hardening

### Goal

Make compatibility an intentional tested contract.

### Work

- extension compatibility suite;
- skill loading;
- theme loading;
- package install sources;
- provider/model behavior;
- config migration tests;
- document supported incompatibilities.

### Exit criteria

- representative Pi packages work;
- incompatibilities are documented rather than accidental;
- Aira-specific behavior does not require package authors to migrate unless they want native Aira APIs.

---

## Phase 14 — Distribution and Bootstrap

### Goal

Ship Aira as one complete product.

### Work

- packaging;
- updater;
- macOS/Linux/Windows paths;
- bootstrap integration;
- post-install doctor;
- dependency handling;
- quiet/noise-controlled updates;
- rollback strategy.

Target:

```text
fresh machine
   ↓
Aira installer/bootstrap
   ↓
aira
   ↓
ready
```

## Development discipline across all phases

- Keep phases small enough to review.
- Run relevant tests before committing.
- **Commit locally whenever a coherent checkpoint works.**
- **Save a written phase report in `aira_product_docs/phases/` when the phase is declared complete** (see `aira_product_docs/phases/README.md`).
- Prefer multiple understandable commits to one giant phase commit.
- Do not automatically push after committing.
- GitHub publication is a deliberate maintainer action.
- Never rewrite or squash useful local checkpoints merely to make history look artificially perfect during active development.
