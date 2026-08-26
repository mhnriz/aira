# Phase 3 — Native Modes and UX: Report

> Status: complete (2026-08-26) | Commits listed at the end are part of this phase.
> Scope honored per product clarification: this phase establishes native
> BUILD / PLAN / REVIEW as Aira host modes with a `Shift+Tab` cycle and a
> genuinely read-only PLAN; it does **not** build the future planning engine or
> the Phase 8 independent verifier. `pi-polished-ui` was treated as a
> prototype/reference; Aira's UI is native and does not depend on that
> standalone extension.

## Product surface established

| Surface | Value |
|---|---|
| mode cycle | `BUILD → PLAN → REVIEW → BUILD` |
| mode shortcut | `Shift+Tab` (`app.mode.cycle`) |
| thinking shortcut | `Ctrl+Shift+E` (moved default off `Shift+Tab`; user bindings preserved) |
| mode owner | canonical `AiraSessionState.mode` (single owner, ADR-005) |
| mode semantics | `src/aira/modes.ts` (cycle, set, tool classification, labels) |
| PLAN enforcement | host/tool-policy level, not a system-prompt instruction |
| commands | unnamespaced `/mode`, `/doctor` (ADR-017) |
| UI | always-visible footer mode badge; startup hint; `/status` reflects mode |

## Where the Aira boundary was placed and why

```text
src/aira/
├── index.ts              public surface (now re-exports modes + mode/doctor commands)
├── modes.ts              NEW: mode semantics — cycle, tool policy, labels/glyphs
├── commands/mode.ts      NEW: /mode report builder + arg parser
├── commands/doctor.ts    NEW: /doctor (Phase 3 scope) health check
├── state.ts              mode field doc updated (now switchable, still canonical owner)
└── (lifecycle, meta, paths, status, migration unchanged from Phases 1–2)
```

Host changes stay narrow seams:

```text
Pi host / tool boundary            Aira bridge                     Aira subsystem
AgentSession.setAiraMode()      →   writes AiraSessionState.mode  → applies tool availability
AgentSession.beforeToolCall()   →   PLAN gate (isAiraMutatingTool) → blocks mutating tools
CustomEditor app.mode.cycle     →   interactive cycle handler     → cycleAiraMode(state)
interactive !bash user escape   →   PLAN gate                     → refused
```

The mode value lives only in the canonical state. `modes.ts` owns *semantics*:
how it cycles and what policy derives from it. No second mode-state owner was
introduced (ADR-005); the host writes `state.mode` only through the modes
module helpers or `AgentSession.setAiraMode`.

## Host files modified

| File | Change |
|---|---|
| `core/keybindings.ts` | added `app.mode.cycle` (default `shift+tab`); moved `app.thinking.cycle` default to `ctrl+shift+e`; both in `AppKeybindings` |
| `core/extensions/runner.ts` | reserved `app.mode.cycle` as editor-global for extension-conflict diagnostics |
| `core/agent-session.ts` | `get airaMode`; `setAiraMode` (writes canonical mode + mode-aware tool availability); `beforeToolCall` PLAN gate |
| `core/slash-commands.ts` | registered `/mode` and `/doctor` in `BUILTIN_SLASH_COMMANDS` |
| `modes/interactive/interactive-mode.ts` | `app.mode.cycle` handler → cycle; `/mode` / `/doctor` dispatch; `!bash` PLAN gate; startup hint |
| `modes/interactive/components/footer.ts` | always-visible mode badge, ANSI-safe truncation |

## Aira-native files created

`src/aira/modes.ts`, `src/aira/commands/mode.ts`, `src/aira/commands/doctor.ts`,
with tests `test/aira/modes.test.ts`, `test/aira/keybindings.test.ts`,
`test/aira/plan-readonly.test.ts`, `test/aira/commands/{mode,doctor}.test.ts`.

## Mode behavior

Cycle is `BUILD → PLAN → REVIEW → BUILD`, deterministic and immediate (writes
canonical state + applies host policy + re-renders footer). Display:

```text
◈ BUILD    full tool set, normal engineering execution
◇ PLAN     read-only: bash/powershell/edit/write blocked AND hidden; read/grep/find/ls available
◎ REVIEW   inspection-oriented; tool set retained (not the Phase 8 verifier)
```

`/mode` shows the current mode, `/mode cycle` advances, `/mode <build|plan|review>`
sets it explicitly. `/status` reports `mode:` from canonical state.

## PLAN read-only enforcement (host/tool-policy, defense in depth)

1. **Execution boundary** — `AgentSession.beforeToolCall` returns `{ block, reason }`
   for any built-in mutating tool in PLAN, even if one is still in the registry.
2. **Availability** — entering PLAN sets the active tool set to the read-only
   tools and remembers the prior set; leaving PLAN restores it.
3. **User escape hatch** — the interactive `!bash` / `!!bash` path is refused in PLAN.

Reading, search, inspection, and other safe operations remain usable through
`read`, `grep`, `find`, `ls`.

Documented Phase 3 limitation (ADR-020): extension tools are not classified as
mutating, so an extension-registered mutation-capable tool could theoretically
run in PLAN. Built-in mutation tools are fully gated; classifying extension
tools is a later-phase concern.

## Keybinding conflict handling

Pi's keybindings already separate defaults from user bindings
(`~/.aira/agent/keybindings.json` overrides defaults via `KeybindingsManager`).
Adding `app.mode.cycle = shift+tab` and moving `app.thinking.cycle` to
`ctrl+shift+e` therefore never overwrites a user customization: a user who
bound `Shift+Tab` to thinking keeps it; the default move only affects users who
never customized. `Shift+Tab` was previously owned by the thinking cycle, which
is exactly the documented condition under which it moves (ADR-006,
AIRA_ARCHITECTURE.md §5). `app.mode.cycle` is editor-global and reserved so
extension conflicts are diagnosed like other builtins. `/status` shows `mode:`;
`/doctor` verifies the two shortcuts resolve to the expected defaults.

## `/doctor` (Phase 3 scope)

Unnamespaced, restrained, deterministic health check over the native modes/UX
surface (not a dashboard):

```text
Aira doctor
home: ~/.aira
ok   home: ~/.aira (.aira)
ok   session state: mode build (active)
ok   mode shortcut: app.mode.cycle: shift+tab
ok   thinking shortcut: app.thinking.cycle: ctrl+shift+e
ok   plan read-only: blocked: bash, powershell, edit, write | allowed: read, grep, find, ls
summary: 5/5 checks passed
```

Later phases extend this (project/capability/runtime health).

## UI (restrained native identity)

Absorbed the useful `pi-polished-ui` idea of a single clean, always-visible,
ANSI-safe status surface as **native host UI** rather than an extension widget:
a one-token mode badge in the footer (`◈ BUILD` / `◇ PLAN read-only` /
`◎ REVIEW`), colored per mode, truncation-safe with the existing
`truncateToWidth`. No dependency on the standalone `pi-polished-ui` extension;
the header keeps Pi's startup hints (now including "Shift+Tab to cycle mode").

## Tests added

- **modes** (8): cycle BUILD→PLAN→REVIEW→BUILD, pure `nextAiraMode`, explicit
  set, read-only classification, mutating/read-only tool sets, labels/glyphs.
- **keybindings** (4): mode.cycle owns Shift+Tab; thinking moved to Ctrl+Shift+E;
  a user `thinking.cycle: shift+tab` customization is preserved; no default conflict.
- **plan-readonly** (7): BUILD starts with the default set; PLAN restricts to
  read-only tools; leaving PLAN restores; `beforeToolCall` blocks bash/powershell/
  edit/write in PLAN and allows read/grep/find/ls; no block outside PLAN; canonical
  state stays authoritative.
- **/mode** (5): report build/unavailable, PLAN read-only flag, format, arg parse.
- **/doctor** (6): all checks pass with live state + defaults, wiring failure is
  explicit, invalid mode fails, shortcut defaults verified, tool-classification
  verified, formatted report has a summary.

## Verification commands and results

Each commit runs the repo-wide `npm run check` via the pre-commit hook: biome
`--write --error-on-warnings` (whole repo), pinned-deps, ts-imports, shrinkwrap,
install-lock, `tsgo --noEmit`, browser-smoke — **PASS on every Phase 3 commit
(6 commits)**.

Focused test run (`vitest --run test/aira/ test/settings-manager.test.ts
test/suite/agent-session-runtime.test.ts`): **14 files, 131 passed, 0 failed.**

Package `tsgo --noEmit`: PASS.

Full non-e2e suite (`./test.sh`, isolated HOME): coding-agent **247 passed /
6 skipped; 2054 passed / 50 skipped (no failures)**; all other workspaces
passed. One pre-existing/environmental failure, unchanged from Phase 2:
`packages/ai zai-coding-plan-models` (machine-hydrated catalog data gives
`glm-5.3` a price the upstream test expects to be zero; zero Phase 3 diff in
`packages/ai`).

## Compatibility concerns

- The npm package still ships both `aira` and `pi` bins; no path, package, or
  API surface changed for extensions/skills/themes.
- Extensions that registered a `mode` or `doctor` slash command now get the
  standard builtin-conflict diagnostic (consistent with other builtins).
- The thinking-cycle default change is the only keybinding default a user could
  observe; user customizations are preserved. Documented `Shift+Tab` reservation.
- `FooterComponent` gained a mode badge; its render contract is unchanged.

## Architectural decisions that became ADRs

- **ADR-020 — Native modes are host-enforced; PLAN is read-only at the tool-policy boundary**
  (records the single mode-owner, `Shift+Tab` cycle + `/mode`, thinking moved to
  `Ctrl+Shift+E`, the three-layer PLAN gate, the extension-tool limitation, and
  that Aira does not depend on `pi-polished-ui`).

Also fixed as part of this phase: the Phase 2 report contained `aria import --pi`
typos (lines 41, 72, 76, 87); the canonical executable remains `aira` (package
`bin` and `cli/args.ts` unchanged). Those typos are corrected.

## Local Git commits created (nothing pushed)

```text
c4064a87b feat(aira): add native mode cycle and tool policy
a183c1451 feat(core): bind mode cycle to Shift+Tab, move thinking to Ctrl+Shift+E
bd9dc4b29 feat(agent): enforce PLAN read-only at host/tool-policy boundary
d8a63771d feat(commands): add native /mode and /doctor, wire mode cycling into the host
707f80cd8 feat(ui): surface the Aira mode badge in the footer
```

(The changelog, ADR-020, phase README table, Phase 2 typo fix, and this report
are committed as the final docs commit.)

## Final `git status`

Clean working tree. `main` = docs commit at the end of this phase; ahead of
`upstream/main`, behind by 29 (baseline divergence). Only remote: `upstream`
(Pi). No `origin`, nothing pushed, nothing published.

## Stopping point / next phase

Stopped after Phase 3 per roadmap discipline — no Phase 4+ functionality has
leaked in. Next: **Phase 4 — Project Awareness** (Git-root detection, language/
framework/package-manager classification, test/build/dev command discovery,
browser-relevance heuristic, project confidence, workspace-boundary safeguards).
