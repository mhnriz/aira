# Aira Product Architecture

> Status: initial architecture freeze  
> Model: standalone Pi-derived product with Pi compatibility  
> Canonical home: `~/.aira/`  
> Canonical executable: `aira`

## 1. Product boundary

Aira is built from Pi's source code rather than implemented as a coordinating Pi extension.

```text
Pi upstream
    ↓
Pi-derived runtime foundation
    ↓
Aira native harness
    ↓
complete Aira product
```

This removes artificial extension boundaries around host-level concerns such as modes, tool visibility, keybindings, session state, permissions, compaction, orchestration, and UI.

Pi compatibility is preserved as a platform contract so the ecosystem remains useful.

## 2. Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                            AIRA                              │
├──────────────────────────────────────────────────────────────┤
│ Pi-derived Runtime                                           │
│ models · providers · tools · sessions · TUI · package loader │
├──────────────────────────────────────────────────────────────┤
│ Native Harness                                               │
│ intent router · state machine · modes · orchestrator         │
│ task graph · capability router · supervision                 │
├──────────────────────────────────────────────────────────────┤
│ Native Engineering                                           │
│ project detector · repo intelligence · diagnostics           │
│ processes · tests · browser · git · verification             │
├──────────────────────────────────────────────────────────────┤
│ Agents                                                       │
│ Scout · Researcher · Verifier                                │
├──────────────────────────────────────────────────────────────┤
│ Policy                                                       │
│ permissions · workspace boundaries · trust · hooks           │
├──────────────────────────────────────────────────────────────┤
│ Native UX                                                    │
│ editor · status lane · footer · modes · diff/review          │
├──────────────────────────────────────────────────────────────┤
│ Pi Compatibility                                             │
│ extensions · skills · themes · package syntax · migration    │
└──────────────────────────────────────────────────────────────┘
```

## 3. Source boundary

Keep Aira-specific implementation isolated wherever practical so upstream Pi remains mergeable.

Preferred conceptual structure:

```text
src/
├── core/                 # Pi-derived runtime; minimize invasive changes
├── ui/                   # Pi-derived host UI
├── extensions/           # Pi-compatible extension machinery
├── compat/
│   └── pi/               # compatibility and migration behavior
└── aira/
    ├── harness/
    ├── modes/
    ├── project/
    ├── intelligence/
    ├── execution/
    ├── browser/
    ├── agents/
    ├── supervision/
    ├── policy/
    └── ui/
```

Exact paths should follow the upstream repository once inspected. The architectural requirement is separation, not these literal folder names.

Prefer narrow host integration seams:

```text
Pi lifecycle event
       ↓
Aira bridge
       ↓
Aira subsystem
```

over scattering Aira-specific conditions throughout upstream code.

## 4. Canonical state

Aira must have one session-state owner.

```text
AiraSessionState
├── mode
├── objective
├── intent
├── taskClass
├── plan
├── taskGraph
├── project
├── workingSet
├── capabilities
├── activeProcesses
├── supervision
├── checkpoints
└── verification
```

No subsystem or compatibility extension may create a competing source of truth for these concepts.

## 5. Modes

### BUILD

Default mode. Editing and normal engineering execution are enabled subject to policy.

### PLAN

Read-only project mode. Reading, search, repository intelligence, research, and read-only LSP operations remain available. Project mutations are blocked at the host/policy layer.

### REVIEW

Inspection-oriented mode. Diff, diagnostics, tests, runtime evidence, requirements, and verification are prioritized. Unrestricted implementation is not silently permitted.

Native mode cycle:

```text
Shift+Tab
BUILD → PLAN → REVIEW → BUILD
```

Thinking/effort may move to `Ctrl+Shift+E`.

## 6. Intent and complexity

Modes are user-visible state. Intent is an internal orchestration hint.

Initial intents:

```text
direct
investigate
implement
debug
refactor
review
research
plan
operate
```

Complexity should scale execution:

```text
trivial
  → direct

moderate
  → understand → implement → diagnose → verify

complex
  → understand → plan → decompose → execute → verify → repair

durable
  → persistent task state → bounded autonomous rounds → independent verification
```

Do not spawn a team for trivial changes.

## 7. Project awareness

Aira should derive a project profile from repository signals:

```text
ProjectProfile
├── root
├── git
├── languages[]
├── frameworks[]
├── packageManagers[]
├── testCommands[]
├── buildCommands[]
├── devCommands[]
├── browserRelevant
├── deploymentHints[]
└── confidence
```

Project scope is a safety boundary. Aira must not treat the user's entire home directory as a repository by default.

## 8. Capability router

Aira should expose a native capability abstraction so implementations remain replaceable.

Initial capabilities:

```text
repo-intelligence
live-code-intelligence
web-research
browser
process
tests
git
subagents
```

Conceptual provider contract:

```text
CapabilityProvider
├── id
├── available()
├── health()
├── activate()
├── deactivate()
└── features[]
```

The router activates only capabilities useful to the current task/project.

## 9. Repository intelligence

Repository intelligence should answer:

> What code and relationships matter to the current objective?

The initial implementation may adapt `pi-codeontime-code-intelligence` rather than immediately reproduce its indexing, graph, semantic retrieval, and learning machinery.

Aira owns when retrieval occurs and how much context reaches the model.

## 10. Live code intelligence

Live code intelligence should answer:

> What does the actual language/toolchain say about the code now?

`pi-lens` is the initial reference/possible engine because it already provides mature LSP, diagnostics, lint/type/format pipelines, structural checks, impact cascades, and freshness handling.

Aira owns orchestration and supervision. Lens does not own Aira's workflow.

## 11. Execution runtime

Aira needs native management for long-running commands.

```text
ProcessRecord
├── id
├── command
├── cwd
├── pid
├── startedAt
├── status
├── logs
└── owner
```

The harness should start/reuse/restart development servers when appropriate and consume their logs without requiring the user to manage tmux manually.

Testing should distinguish targeted checks, related tests, full suites, builds/type checks, and runtime/browser verification.

## 12. Browser

Browser and public-web research are separate capabilities.

Default browser behavior:

- isolated Aira profile;
- DOM/accessibility-tree inspection first;
- CDP/runtime console/network evidence;
- screenshots/vision when appearance matters;
- personal signed-in browser only through explicit authorization.

Desired web-app verification:

```text
edit
 ↓
diagnostics
 ↓
start/reuse app
 ↓
browser
 ├── DOM/a11y
 ├── interaction
 ├── console
 ├── network
 └── screenshot when useful
 ↓
verification evidence
```

## 13. Agents

Keep the permanent taxonomy deliberately small.

### Scout
Read-only exploration for unfamiliar or cross-cutting repositories.

### Researcher
External documentation/research when local information is insufficient.

### Verifier
Independent fresh-context completion review.

The root agent can act as Builder initially; a permanent Builder subprocess is not required.

Subagents never own competing canonical task state.

## 14. Verification

Verification combines independent evidence:

```text
                  VERIFY
                    │
       ┌────────────┼────────────┐
       │            │            │
 diagnostics      tests       reasoning
       │            │            │
 code health     behavior     requirements
 types/lint      runtime      architecture
 structure       browser      edge cases
```

Verifier outcomes:

```text
PASS
FAIL
INCONCLUSIVE
```

`INCONCLUSIVE` must never silently become `PASS`.

## 15. Supervision

All findings should normalize into one Aira-owned bus.

Sources include:

- diagnostics;
- tests/build;
- browser runtime;
- process failures;
- verifier;
- policy.

Aira decides whether to repair, retry, surface, pause, ask, or fail. Third-party engines should not each dominate the user interface.

## 16. Permissions and trust

Suggested normal policy:

```text
workspace reads/search       allow
workspace edits              allow
normal tests/build           allow
git status/diff/log          allow

dependency installation      ask
git commit                   configurable
git push                     ask
outside-workspace writes     ask
system configuration         ask
destructive shell            ask/deny
secrets                      deny by default
```

A repository cannot grant itself additional privileges.

Future `.aira` project hooks must be explicitly trusted by exact configuration hash; modifying the configuration invalidates trust.

## 17. Compaction

Aira should preserve engineering state rather than trusting generic conversation summarization.

Persist:

```text
objective
plan
task graph
decisions
working set
important references
unresolved findings
process state
verification state
```

Code can be retrieved again from repository intelligence rather than copied wholesale into checkpoints.

## 18. UX

Aira should absorb the useful work prototyped in `pi-polished-ui` into native host UI over time.

Example:

```text
AIRA ◈ BUILD   stream-web   main   ✓ healthy
AIRA ◇ PLAN    stream-web   main   read-only
AIRA ◎ REVIEW  stream-web   main   SUP 1
```

Do not expose every internal engine all the time.

Minimal explicit controls:

```text
/aira
/aira status
/aira doctor
/aira capabilities
/aira processes
/aira checkpoint
/aira rewind
/aira mode
```

Routine engineering capabilities should activate automatically.

## 19. Pi compatibility

Aira should preserve, wherever practical:

- Pi extension APIs;
- Pi skills;
- Pi themes;
- Pi provider/model compatibility;
- Pi package source syntax such as `npm:` and `git:`;
- familiar package management behavior.

Canonical Aira paths remain under `~/.aira/`. Compatibility code may import or migrate from `~/.pi/`, but Aira must not require `~/.pi/` for normal operation.

## 20. Architectural invariants

1. Aira is a standalone product.
2. `aira` is the canonical executable.
3. `~/.aira/` is the canonical home.
4. Aira owns native UX, modes, state, orchestration, and policy.
5. Pi compatibility is preserved where practical but does not dictate Aira UX.
6. Aira-specific code stays isolated from upstream-derived code wherever practical.
7. One canonical state owner exists per session.
8. Plan mode is genuinely read-only.
9. Task complexity controls orchestration complexity.
10. Subagents do not own competing task truth.
11. Verification is independent from implementation completion claims.
12. Browser defaults to an isolated profile.
13. Projects cannot silently grant privileges.
14. Optional specialist engines degrade gracefully.
15. Mature machinery is not rewritten without a measured reason.
16. The existing `engineering-loop` is not part of this architecture.
17. Development uses frequent local Git commits; publishing/pushing is a separate action.
