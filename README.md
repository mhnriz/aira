# Aira

> A complete, opinionated coding-agent harness derived from Pi and built as its own product.

Aira starts from Pi's runtime and ecosystem, then integrates the behavior expected
from a modern engineering harness directly into the host: project awareness, native
modes, code intelligence, diagnostics, process management, browser verification,
orchestration, supervision, and independent verification.

Aira is not "Pi plus a pile of extensions." The goal is one coherent product.

```text
$ aira

 AIRA ◈ BUILD   project-name   main   ✓ healthy

> fix the reconnect bug and verify it
```

**Aira speaks Pi, but Aira owns its world.**

## Status

Phase 0 (fork and baseline) is complete. See [BASELINE.md](BASELINE.md) for the fork
point, remotes, and verified baseline state. Current development is on `main`.

## Product documentation

All product decisions, architecture, and the roadmap live in [`aira_product_docs/`](aira_product_docs/):

| Document | Contents |
|---|---|
| [README.md](aira_product_docs/README.md) | Product identity, principles, native surface |
| [AIRA_ARCHITECTURE.md](aira_product_docs/AIRA_ARCHITECTURE.md) | Architecture freeze, invariants (ADRs) |
| [DECISIONS.md](aira_product_docs/DECISIONS.md) | ADR-001 … ADR-016 |
| [ROADMAP.md](aira_product_docs/ROADMAP.md) | Phase 0 → 14 build order |
| [DEVELOPMENT.md](aira_product_docs/DEVELOPMENT.md) | Git discipline, upstream sync, agent rules |
| [COMPATIBILITY.md](aira_product_docs/COMPATIBILITY.md) | Pi compatibility contract |
| [phases/](aira_product_docs/phases/) | Written report for each completed roadmap phase |

## Repository layout

```text
packages/            Pi-derived monorepo workspaces (agent · ai · client ·
                     coding-agent · protocol · server · telemetry · tui …)
scripts/             build/verification scripts
aira_product_docs/   Aira product documentation
BASELINE.md          fork point and verified baseline state
```

Aira-native implementation will live in an isolated `src/aira/` boundary (Phase 1+)
rather than scattered through upstream-derived code, per
[AIRA_ARCHITECTURE.md](aira_product_docs/AIRA_ARCHITECTURE.md).

## Development

```bash
npm install
npm run build          # builds all workspaces
npm run test           # full suite (note: Ollama tests need a local server)
npx tsgo --noEmit      # type check
```

Remotes: `upstream` is official Pi; `origin` (Aira) is set when the repository exists.
Frequent local commits are the expected workflow — pushing is a separate maintainer
action. See BASELINE.md and `aira_product_docs/DEVELOPMENT.md`.