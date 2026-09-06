# Phase 14 follow-up: SQLite host ownership and live forks

Upstream reference: `5cf1b95` (`docs(agent): align SQLite ownership with session workers`).

## Objective

Align SQLite with Aira's host-authoritative Session lifecycle. Exactly one
host-assigned process owns a writable Session, normally its Session worker.
Storage must not independently claim, renew, or take over ownership.

## Required work

- Remove the SQLite `writer_leases` table, claim/renew/release helpers, renewal
  timer, lease-loss path, and pre-commit renewal callback.
- Preserve same-repository fork ordering through the active storage queue.
- Add a no-create, read-only SQLite connection for a source owned by another
  process, using one deferred read transaction while the worker continues WAL
  commits.
- Make active-source lookup use exact physical identity plus Session ID.
- Serialize repository deletion against local open handles and make close
  drain all owned handles before releasing resources.
- Encode arbitrary Session IDs safely in per-session paths.

## Safety constraints

Do not replace the removed lease with another storage lock, takeover timer,
tombstone, fencing token, or generic lock manager. A second writable process is
a host lifecycle defect; the supported cross-process overlap is a read-only
fork snapshot. Validate the change across Memory, JSONL, and SQLite conformance
behavior, including crash/close and live-worker fork cases.

Relevant upstream references: `packages/agent/docs/harness.md`,
`packages/agent/docs/post-wp05-roadmap.md`,
`packages/agent/docs/work-packages/07-sqlite-host-ownership-live-forks.md`,
`packages/session-backends/sqlite-node/src/`, and its tests/benchmarks.
