# Aira Baseline

> Status: established (Phase 0 of [ROADMAP.md](aira_product_docs/ROADMAP.md))
> Last updated: 2026-08-26

## Fork point

| | |
|---|---|
| Upstream repository | `https://github.com/earendil-works/pi.git` |
| Remote name | `upstream` |
| Base version | Pi `0.84.3` |
| Base commit | `4e58f324f` — "Release v0.84.3" |
| Base tag | `v0.84.3` |
| Local tag | `baseline-pi-0.84.3` |

The npm-installed `pi` CLI on this machine (`@earendil-works/pi-coding-agent@0.84.3`) matches this baseline.

## Remotes

```text
upstream   https://github.com/earendil-works/pi.git   (official Pi)
origin     <unset>                                    (Aira repository — set when it exists)
```

## Baseline deviations from upstream

Exactly one commit is cherry-picked from upstream `main` onto the fork point because
the `v0.84.3` tag itself does not build:

| Local commit | Upstream original | Reason |
|---|---|---|
| `fix(ai): cloudflare gateway type, include workers` | `e8c632ef6` | `packages/ai` fails `npm run build` at v0.84.3 (`cloudflare-ai-gateway.ts` TS2353 — `"openai-completions"` not in provider stream map type). Fixed upstream; cherry-picked so the baseline builds. |

Everything else in the working tree is byte-identical to `v0.84.3`.

## Verified state (Node v25.9.0, npm 11.12.1)

| Check | Result |
|---|---|
| `npm install` | OK (317 packages) |
| `npm run build` (all workspaces) | PASS |
| `tsgo --noEmit` (type check) | PASS |
| `npm run test:scripts` | 5/5 PASS |
| workspace tests | see below |

## Pre-existing test failures (not caused by Aira)

1. **`packages/ai` — Ollama E2E integration tests.** Tests such as
   `test/stream.test.ts` (gpt-oss-20b via Ollama) and
   `test/context-overflow.test.ts` require a running local Ollama server.
   They fail on machines without Ollama. Environment-dependent, not a code defect.

2. **`packages/coding-agent` — `test/footer-data-provider.test.ts`**
   "debounces rapid reftable updates into a single async refresh" is
   timing-sensitive and flaky under full-suite load: it passed
   `vitest run test/footer-data-provider.test.ts` in isolation. Known
   flakiness, not a regression.

## Development notes

- Local commits are the expected workflow; **do not push** unless the maintainer
  explicitly asks. See [DEVELOPMENT.md](aira_product_docs/DEVELOPMENT.md).
- Next roadmap phase: **Phase 1 — Aira Core Seam**
  (native `src/aira/` boundary, `AiraSessionState`, lifecycle bridge, `/aira status`).