# Aira UI Backlog

Future Aira UI-overhaul requirements. These are recorded product/design
intents; **none of them are implemented yet.** Each entry stays a backlog
item until its owning phase picks it up.

---

## B-001 — Ambient language-intelligence / LSP state in the native bottom bar

**Status:** backlog (future Aira UI overhaul; explicitly NOT part of Phase 6)

**Problem:** language-intelligence/LSP state is currently only visible
through `/doctor` or model-facing context. The user should be able to see,
at a glance, whether the language toolchain backing the current file is
cold, ready, or reporting findings — without running a slash command.

**Desired direction** (the eventual native bottom bar should surface
language-intelligence/LSP state ambiently):

```text
◈ BUILD  │  LSP TS ○          (cold/unprobed)
◈ BUILD  │  LSP TS ✓          (ready, clean)
◈ BUILD  │  LSP TS 2E 1W      (ready, findings: 2 errors, 1 warning)
```

When findings exist, also show a compact highest-priority/current finding
when terminal width allows:

```text
◈ BUILD │ LSP TS 2E 1W │ TS2304: Cannot find name 'handle'
```

Constraints:

- The UI must truncate intelligently and avoid becoming noisy.
- Multi-language projects should use a compact representation, for example:

```text
LSP TS ✓ · PY ✓
```

**Explicitly deferred:** this is a UI overhaul item only. Phase 6 (execution
runtime) must not implement any bottom-bar/footer redesign; the canonical
health state it builds on is `AiraSessionState.intelligence`
(`/doctor` reports it today).