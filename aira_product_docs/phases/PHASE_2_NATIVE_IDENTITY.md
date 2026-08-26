# Phase 2 — Native Identity and `~/.aira/`: Report

> Status: complete (2026-08-26) | Commits listed at the end are part of this phase.
> Convention: every phase gets a report in this directory — see [README.md](README.md).
> User clarification honored: Pi-derived internals/packages are not renamed for
> branding; Aira owns the user/product surface (`aira`, `~/.aira/`, Aira
> branding), while Pi-compatible internal APIs/package machinery stay intact
> for compatibility and upstream syncing.

## Product surface established

| Surface | Value | Mechanism |
|---|---|---|
| canonical executable | `aira` | new `bin` entry in `packages/coding-agent/package.json`; `pi` kept as compatibility alias to the same bundle |
| canonical home | `~/.aira/` | `piConfig.configDir = ".aira"` (Pi's official fork seam) |
| internal layout | `~/.aira/agent/...` | preserved from Pi (`~/.pi/agent/...` shape) via the same `piConfig`; resources are re-pointed, not restructured |
| product name | `aira` | `piConfig.name = "aira"` → `APP_NAME`, `APP_TITLE` |
| Aira version | `Aira 0.1.0` | independent of Pi; `PACKAGE_NAME`/`VERSION` stay the Pi-derived package identity (`@earendil-works/pi-coding-agent@0.84.3`) |
| env overrides | `AIRA_CODING_AGENT_DIR` / `AIRA_CODING_AGENT_SESSION_DIR` | derived from `APP_NAME`; legacy `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` honored as compatibility aliases |
| debug log | `~/.aira/agent/aira-debug.log` | `APP_NAME`-derived |
| project-local config | `<cwd>/.aira/` | replaces `<cwd>/.pi/` (single `CONFIG_DIR_NAME`) |

`--version` now prints `Aira 0.1.0 (Pi base 0.84.3)`. `/status` reports the
product identity and canonical home. Home resources moved because every path
helper is centralized in `config.ts` and derives from `CONFIG_DIR_NAME` /
`APP_NAME`: settings, sessions, model/catalog cache, extensions, skills,
themes, prompts, agents, tools, `bin/`, keybindings, trust, and logs.

## Where the Aira boundary was placed and why

`src/aira/` (established in Phase 1) gains two identity modules and one
migration module; host changes stay narrow:

```text
src/aira/
├── index.ts              public surface (now includes meta, paths, migration)
├── meta.ts               Aira product metadata/versioning (new)
├── paths.ts              canonical Aira home path helpers + resource registry (new)
├── migration.ts          optional Pi→Aira import engine (new)
├── commands/status.ts    /status now reports product identity and home
├── commands/import.ts    `aria import --pi` CLI command (new)
├── lifecycle.ts          unchanged (Phase 1)
└── state.ts              unchanged (Phase 1)
```

The entire home move is one upstream-designed seam: `piConfig` in
`packages/coding-agent/package.json`. No path literal was scattered; the
existing `config.ts` helpers (all `get*Dir`/`get*Path`) now resolve under
`~/.aira/`. Aira-specific additions live only in `src/aira/`.

## Host files modified

| File | Change |
|---|---|
| `package.json` | `piConfig` → `{ name: "aira", configDir: ".aira" }`; `bin` gains `aira` (keeps `pi`) |
| `config.ts` | legacy `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` aliases honored by the path helpers; comment updates |
| `main.ts` | `--version` prints the Aira identity; `import` command dispatch; session-dir env legacy alias |
| `cli/args.ts` | help gains `import --pi`; help text already reflects `CONFIG_DIR_NAME`/`ENV_*` |
| `modes/interactive/interactive-mode.ts` | `/trust` hint "restart pi" → `restart ${APP_NAME}`; comment |
| `core/{package-manager,sdk,session-manager,trust-manager}.ts`, `migrations.ts` | comment/doc-string updates only |

## Pi compatibility postures (deliberate)

- `pi` bin kept as an alias; extension `pi` manifest field, provider
  attribution headers, `PI_*` env flags/data (`PI_OFFLINE`, `PI_TELEMETRY`,
  `PI_PACKAGE_DIR`, `PI_EXPERIMENTAL`, managed-install env), and the Pi
  package name all remain intact.
- Project-local imports of Pi tooling and test isolation keep working because
  the legacy `PI_CODING_AGENT_DIR` env name is still honored.
- Pi's official first-time-setup is gated to the official distribution
  (`isOfficialDistribution`); Aira skips it (its own onboarding lands later).
- `aria/pi update`, managed installs, and self-update remain Pi-oriented until
  Aira distribution exists (Phase 14). The `pi` alias `--version` now reports
  the Aira identity, which contains the Pi base version.

## Optional Pi migration — `aria import --pi`

Detects `~/.pi/agent`, copies supported resources into `~/.aira/agent`
(settings, keybindings, models, models-store, trust, themes, skills, prompts,
extensions, agents, tools, `bin`, sessions). Conservative by default: shadow
`auth.json` only with `--include-secrets`; never overwrites existing Aira
resources unless `--force`; `--dry-run` previews without touching the disk; a
successful import records `~/.aira/migration.json`. Normal operation never
reads `~/.pi`. Project-local `.pi/` content is not auto-migrated (documented
limitation; `--session-dir` / manual copy available).

Verified end-to-end with an isolated `HOME`: `aria import --pi` copied
settings/extensions/sessions, skipped `auth.json`, and wrote the marker; the
dry run copied nothing and created no `~/.aira`.

## Tests added / updated

- `test/aira/meta.test.ts` (new, 4): Pi package identity intact, independent
  Aira version, formatted strings.
- `test/aira/paths.test.ts` (new, 8): canonical home under `~/.aira`, no `.pi`
  in resolved paths, project-local `.aira/`, Phase 2 resources under the home,
  resource registry coverage, legacy env alias, `displayPathUnderHome`.
- `test/aira/migration.test.ts` (new, 10): source resolution, importability,
  copy semantics, exec-bit preservation, secret opt-in, marker, dry-run,
  no-overwrite, force-overwrite, self-import guard.
- `test/aira/commands/import.test.ts` (new, 5): command dispatch, source
  requirement, no-op, real import, unknown option.
- `test/aira/commands/status.test.ts` (updated): `/status` now asserts product
  identity + home.
- Existing tests updated for `.pi` → `.aira` (project-local and `~/.pi`
  fixture/home paths) across ~20 coding-agent test files, plus
  `packages/ai/test/oauth.ts`, `packages/evals/src/extensions.eval.ts`, and
  `packages/agent/test/harness/resource-formatting.test.ts`; `pi`→`aira` surface
  strings in package-command/credential/session tests; the
  first-time-setup assertion now expects Aira (non-official) to skip Pi setup;
  `package-distribution.test.ts` asserts both `aira` and `pi` bins.
- Example extension/sdk docs updated to `~/.aira` paths.

## Verification commands and results

| Check | Result |
|---|---|
| coding-agent full suite (`vitest --run`) | 242 files passed, 6 skipped; 2025 passed, 50 skipped (no failures) |
| `tsgo --noEmit` (package + root, via `npm run check`) | PASS |
| pre-commit `npm run check` (biome, pinned deps, ts-imports, shrinkwrap, install-lock, browser smoke) | PASS on every commit |
| `npm run build` (coding-agent package) | PASS (bundle rebuilt, 48 files / 7.1 MiB) |
| built bundle smoke (isolated `HOME`, `aira` symlink to `dist/bundle/cli.js`) | `--version` = `Aira 0.1.0 (Pi base 0.84.3)`; `--help` shows `import --pi`/`.aira`; `import --pi` copies Pi home and writes marker; `--help` created only `~/.aira` (no `~/.pi`) |
| `./test.sh` (isolated HOME, no API keys, all workspaces) | 2024/50 coding-agent, 947/830 ai, plus client/server/agent/telemetry/tui suites passed. Two failures, both pre-existing/environmental: `packages/ai zai-coding-plan-models` (machine-hydrated catalog data gives `glm-5.3` a price the upstream test expects to be zero; zero Phase 2 diff in `packages/ai`) and coding-agent `footer-data-provider` (documented flake in BASELINE.md) |

## Compatibility concerns

None broken by tests. The legacy `PI_CODING_AGENT_DIR` env alias was added
precisely so Pi tooling and test isolation (e.g. `openai-codex-stream.test.ts`,
`2791-fswatch-error-crash.test.ts`) keep working after the env rename. The TUI
package's own log-dir fallback still mentions `PI_CODING_AGENT_DIR`/`~/.pi`;
Aira always passes its agent dir explicitly, so that fallback never fires in
normal operation and the Pi package was left untouched (Phase 13 can revisit).

## Architectural decisions that became ADRs

- **ADR-019 — Aira owns its home and product identity; Pi compatibility is
  preserved as an isolated migration surface** (records the executable pair,
  home/agent layout, independent versioning, env aliases, and conservative
  import semantics).

## Local Git commits created (nothing pushed)

```text
a7da0ccac feat(config): establish Aira home ~/.aira/ and canonical aira executable
42d4bd14e feat(aira): add Aira product metadata and canonical home path helpers
3ba71047d feat(aira): add optional Pi home import command
```

(The docs + ADR-019 + this report are committed as the final docs commit.)

## Final `git status`

Clean working tree. `main` = docs commit at the end of this phase; ahead of
`upstream/main` by 11+ (baseline divergence), behind by 29. Only remote:
`upstream` (Pi). No `origin`, nothing pushed, nothing published.

## Stopping point / next phase

Stopped after Phase 2 per roadmap discipline — no Phase 3+ functionality has
leaked in. Next: **Phase 3 — Native Modes and UX** (absorb `pi-polished-ui`,
BUILD/PLAN/REVIEW, `Shift+Tab` cycle, PLAN read-only enforcement, mode-aware
tools, keybinding audit, initial `/aira doctor` — as unnamespaced `/doctor`
per ADR-017).
