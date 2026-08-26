# Phase 4 — Project Awareness: Report

> Status: complete (2026-08-27) | Commits listed at the end are part of this phase.
> Scope honored per product clarification: this phase derives an evidence-based,
> lightweight `ProjectProfile` that feeds the canonical Aira session state. It
> does **not** build repository indexing, code graphs, embeddings, LSP/code
> intelligence, browser automation, process management, or orchestration —
> those are roadmap Phase 5+.

## Product surface established

| Surface | Value |
|---|---|
| profile type | `ProjectProfile` (root, git, languages, frameworks, packageManagers, testCommands, buildCommands, devCommands, browserRelevant, deploymentHints, confidence) |
| profile owner | canonical `AiraSessionState.project` (single owner, ADR-005) |
| detection | `src/aira/project/` — synchronous, bounded top-level reads |
| confidence | `none` / `low` / `medium` / `high`, derived from evidence strength |
| safety boundary | home directory and any parent of it is never a project; nearest defensible root wins |
| surfaces | existing native `/status` and `/doctor` only (restrained) |
| ADR | **ADR-021** — project scope from nearest defensible root; canonical state owns the profile |

## Where the Aira boundary was placed and why

```text
src/aira/
├── project/
│   ├── profile.ts      NEW: ProjectProfile type, NO_AIRA_PROJECT, summary
│   ├── detect.ts       NEW: evidence-based, bounded detection + root/confidence logic
│   └── index.ts        NEW: public surface + resolveAiraProject / resolveAiraProjectInto
└── state.ts            project field: "unresolved" placeholder → AiraProjectProfile | undefined
```

The host integration is one narrow seam in the existing Aira lifecycle point:

```text
AgentSession constructor   → resolveAiraProjectInto(state, cwd) → state.project = detectAiraProject(cwd)
```

Detection runs at `AgentSession` construction from the session cwd, so
interactive, print, RPC, and SDK sessions all carry a profile in canonical
state. No second project-state owner was introduced (ADR-005).

## Host files modified

| File | Change |
|---|---|
| `core/agent-session.ts` | added the project-awareness seam in the constructor (calls `resolveAiraProjectInto`) |
| `aira/state.ts` | `project` field now `AiraProjectProfile \| undefined` (undefined = not yet resolved) |
| `aira/index.ts` | re-export `./project/index.ts` |
| `aira/commands/status.ts` | `/status` shows `project: <summary>` from the profile |
| `aira/commands/doctor.ts` | added a `project` check (resolved profile present) |

## Aira-native files created

`src/aira/project/{profile,detect,index}.ts`, with tests
`test/aira/project/detect.test.ts`, and updated
`test/aira/commands/{doctor,status}.test.ts`, `test/aira/state.test.ts`,
`test/aira/lifecycle.test.ts`.

## Detection behavior (evidence-based, lightweight)

Detection reads only bounded top-level directory entries plus small manifest
contents. It derives the profile from:

- **Git root** — a `.git` marker found by climbing from cwd; the nearest marker
  is the Git root, communicated separately from the project root.
- **Manifests/build files** → languages and package managers
  (package.json/tsconfig/lockfiles for Node; pyproject/requirements/setup for
  Python; go.mod; Cargo.toml; *.csproj/*.sln/global.json for .NET;
  CMakeLists/meson/Makefile+src for C/C++; Gemfile; pom.xml/build.gradle;
  composer.json; Package.swift; mix.exs).
- **test/build/dev commands** — from `package.json` scripts where present,
  otherwise conventional per-language commands (`dotnet test`, `cargo build`,
  `python -m pytest`, `go test ./...`, ...).
- **Browser relevance** — front-end frameworks, `index.html`/vite entrypoints,
  web frameworks with HTML signals.
- **Deployment hints** — Dockerfile/compose, `.github/workflows`, CI configs,
  Vercel/Netlify/serverless.
- **Confidence** — `low`/`medium`/`high` from Git + number of distinct
  languages + deployment + browser signals (a bare Git repo is `low`); `none`
  when no defensible root exists.

### Workspace-boundary safeguards

- The home directory — and any ancestor of it — is never a project
  (`isAncestorOrSelf(start, home) ⇒ no project`).
- The climb for a project root stops at the home boundary and never includes
  it.
- The nearest defensible root (Git marker or recognized manifest/build file)
  wins, so a monorepo subpackage with its own manifest is its own project and
  an arbitrary working-directory parent with no signals is not a project.

Example: on this repository, `detectAiraProject` returns
`root: /Users/hariz/proj/aira`, `languages: [TypeScript]`,
`packageManagers: [npm]`, real `test/build/dev` scripts from `package.json`,
`deploymentHints: [github-actions]`, `confidence: high`.

## `/status` and `/doctor` (restrained)

- `/status` → `project: aira (TypeScript) [high]` (root basename + languages +
  confidence).
- `/doctor` → new `project` check that verifies canonical state carries a
  resolved profile; it reports the summary and flags "not resolved yet" when
  the host seam failed to run.

No new slash command and no footer/UI expansion were added, keeping the surface
restrained per the phase instructions. Footer remains the Phase 3 mode badge.

## Tests added

- **project/detect** (13): Node (+Git, scripts, confidence), TypeScript +
  framework + browser, Python, .NET/C#, C/C++ (CMake), mixed Node+Python (high
  confidence), Docker/CI deployment hints, nearest-root preference with
  separate Git root, parent-workspace not a project, home never a project even
  with `.git`, parent-of-home not a project, empty dir → no project, missing
  cwd → no project.
- **/status** updated: `project:` now renders the profile summary (`none` when
  unresolved).
- **/doctor** updated: 6 checks; a resolved project makes the `project` check
  pass; an unresolved project reports a wiring failure.
- **state**/**lifecycle** updated: `project` is now `undefined` until resolved
  (direct acquire) or a profile (real session construction).

## Verification commands and results

Focused run (`vitest --run test/aira`): **13 files, 92 passed, 0 failed.**

Package `tsgo --noEmit` (repo-wide): PASS. Repo-wide `npm run check` (biome
`--error-on-warnings`, pinned-deps, ts-imports, shrinkwrap, install-lock,
`tsgo --noEmit`, browser-smoke): **PASS on every Phase 4 commit (3 commits)**
via the pre-commit hook.

Full non-e2e suite (`./test.sh`): coding-agent **247 passed / 6 skipped; 2067
passed / 50 skipped (no Phase 4 failures)**. Two failures were pre-existing /
environmental and unrelated:
- `packages/ai zai-coding-plan-models` (already documented in Phase 2/3: the
  machine-hydrated catalog gives `glm-5.3` a price the upstream test expects to
  be zero; zero Phase 4 diff in `packages/ai`).
- `packages/coding-agent test/footer-data-provider.test.ts` reftable branch
  detection timed out once under parallel full-suite load; it passed on an
  isolated rerun and is a timing-sensitive fs-watcher test that does not
  construct `AgentSession` (unrelated to Phase 4).

## Compatibility concerns

- The npm package still ships both `aira` and `pi` bins; no path, package, or
  API surface changed for extensions/skills/themes.
- Detection is read-only and side-effect free; it runs at session construction
  for all modes and adds only bounded, cheap filesystem reads.
- `AiraSessionState.project` type changed from a string placeholder to an
  object; only Aira-owned code and its tests referenced it.

## Architectural decisions that became ADRs

- **ADR-021 — Project scope is derived from the nearest defensible root within
  home; canonical session state owns the project profile**
  (records the profile shape, the home safety boundary, nearest-root rule,
  evidence-based confidence, status/doctor-only surfacing, and that detection
  stays out of Phase 5+ semantics).

## Local Git commits created (nothing pushed)

```text
f40b6455e feat(aira): add evidence-based project detection and canonical project profile
235780fd6 feat(agent): resolve project profile into canonical session state at session creation
c28a664dd feat(commands): surface project profile in /status and /doctor with project detection tests
```

(The changelog, ADR-021, phase README table, and this report are committed as
the final docs commit.)

## Final `git status`

Clean working tree. `main` = docs commit at the end of this phase; ahead of
`upstream/main`, behind by 29 (baseline divergence). Only remote: `upstream`
(Pi). No `origin`, nothing pushed, nothing published.

## Stopping point / next phase

Stopped after Phase 4 per roadmap discipline — no Phase 5+ functionality has
leaked in. Next: **Phase 5 — Intelligence** (capability-provider abstraction,
Lens / Code Intelligence adapter spikes, health reporting, relevant-context
retrieval, automatic post-edit diagnostics, graceful degradation).
