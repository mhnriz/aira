# Aira

> A complete, opinionated coding-agent harness derived from Pi and built as its own product.

Aira starts from Pi's runtime and ecosystem, then integrates the behavior expected from a modern engineering harness directly into the host: project awareness, native modes, code intelligence, diagnostics, process management, browser verification, orchestration, supervision, and independent verification.

Aira is not intended to be "Pi plus a pile of extensions." The goal is one coherent product.

```text
$ aira

 AIRA ◈ BUILD   project-name   main   ✓ healthy

> fix the reconnect bug and verify it
```

Aira should decide which capabilities are needed without requiring the user to manually orchestrate `/lsp`, `/browser`, `/review`, `/goal`, `/subagent`, or similar commands.

## Product identity

Canonical surfaces:

```text
Executable      aira
Home            ~/.aira/
Configuration   ~/.aira/settings.json
Keybindings     ~/.aira/keybindings.json
Sessions        ~/.aira/sessions/
Projects        ~/.aira/projects/
Extensions      ~/.aira/extensions/
Skills          ~/.aira/skills/
Themes          ~/.aira/themes/
Agents          ~/.aira/agents/
```

Pi compatibility remains an important platform contract, but Aira owns its paths, defaults, branding, UX, and native behavior.

> **Aira speaks Pi, but Aira owns its world.**

## Core principles

1. Aira is a standalone product, not a Pi extension.
2. Pi remains the upstream runtime foundation.
3. Pi packages should remain compatible wherever practical.
4. Core Aira behavior belongs in the host rather than being simulated through extensions.
5. Specialist engines may remain replaceable internal providers when rewriting them provides no advantage.
6. Normal operation is event- and intent-driven rather than slash-command-driven.
7. Task complexity determines orchestration complexity.
8. One canonical Aira state owner coordinates modes, tasks, supervision, and execution.
9. `~/.aira/` is the only canonical Aira home.
10. Aira should remain reasonably syncable with upstream Pi.

## Native product areas

```text
Aira
├── Pi-derived Runtime
│   ├── model/provider runtime
│   ├── tools
│   ├── sessions
│   ├── package system
│   └── terminal UI
├── Harness
│   ├── intent routing
│   ├── BUILD / PLAN / REVIEW
│   ├── orchestration
│   ├── task state
│   └── supervision
├── Engineering
│   ├── project detection
│   ├── repository intelligence
│   ├── diagnostics/LSP
│   ├── processes/tests
│   ├── browser verification
│   └── verifier
├── Policy
│   ├── permissions
│   ├── project trust
│   └── hooks
├── UX
│   ├── polished editor
│   ├── status lane
│   ├── footer
│   └── diff/review
└── Compatibility
    └── Pi extensions/skills/themes/packages
```

## Initial modes

`BUILD` is the normal implementation mode. `PLAN` is read-only and optimized for understanding and planning. `REVIEW` prioritizes independent inspection and evidence.

The intended native shortcut is:

```text
Shift+Tab
BUILD → PLAN → REVIEW → BUILD
```

Pi's existing thinking/effort shortcut can be moved to `Ctrl+Shift+E` if necessary.

## Development rule

Development must use Git from the beginning. **Make frequent local commits at meaningful, working checkpoints.** Pushing is separate: local history can accumulate until the maintainer is ready to publish to GitHub.

Do not leave an entire phase as one uncommitted working tree.

See [DEVELOPMENT.md](DEVELOPMENT.md), [AIRA_ARCHITECTURE.md](AIRA_ARCHITECTURE.md), and [ROADMAP.md](ROADMAP.md).
