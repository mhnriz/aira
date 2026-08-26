# Developing Aira

Aira is a long-lived fork/product derived from Pi. Development practices must protect both Aira's stability and the ability to consume useful upstream Pi changes.

## 1. Git is mandatory during development

Initialize/use Git from the first minute of development.

**Local commits are part of the engineering workflow, not just publishing.**

Commit after coherent working checkpoints such as:

```text
chore: establish Aira upstream baseline
feat(core): add Aira runtime bridge
feat(config): introduce ~/.aira paths
feat(modes): add native build plan review modes
test(modes): enforce plan read-only behavior
```

A commit should normally represent a state that builds and whose relevant tests pass.

Do **not** work through several major phases with one enormous uncommitted diff.

## 2. Local commit does not mean GitHub push

The expected workflow is:

```text
edit
 ↓
test
 ↓
review diff
 ↓
git commit locally
 ↓
continue development
```

Repeat as needed.

Only later, when the maintainer is ready:

```text
git push
```

It is completely acceptable to accumulate a series of local commits and push them to GitHub together.

Aira tooling/agents must never interpret "commit during development" as permission to push.

## 3. Remotes

Recommended setup:

```text
origin    Aira repository
upstream  official Pi repository
```

Verify before doing any sync work:

```bash
git remote -v
```

Record the Pi base commit/version for each Aira release.

## 4. Branching

A simple model is preferred:

```text
main
├── stable Aira development line
└── feature/* for risky or substantial work
```

An `upstream-sync/*` branch may be used for complicated Pi upgrades.

Do not create elaborate branch ceremony unless the project actually needs it.

## 5. Upstream synchronization

The objective is not to keep Aira identical to Pi. The objective is to make useful upstream changes reasonably integrable.

Before an upstream sync:

1. ensure the Aira working tree is clean;
2. commit all local work;
3. fetch upstream;
4. inspect upstream changes;
5. perform the merge/rebase on a dedicated branch when risk is meaningful;
6. run the complete relevant test suite;
7. inspect Aira integration seams;
8. commit the sync separately.

Never begin a substantial upstream merge with unrelated uncommitted Aira changes.

## 6. Minimize fork pain

Prefer:

```text
upstream code
    ↓
small integration seam
    ↓
src/aira subsystem
```

Avoid:

```text
if (aira) ...
```

scattered through dozens of unrelated upstream functions.

When host modification is necessary, keep it:

- narrow;
- documented;
- tested;
- easy to identify during future upstream diffs.

## 7. Aira paths

`~/.aira/` is canonical.

Never introduce a new `~/.pi/` dependency for native Aira behavior.

Centralize filesystem locations in path/config helpers. Avoid hard-coded `~/.aira` strings throughout the repository.

Compatibility/migration code may read Pi locations explicitly.

## 8. Pi compatibility

When changing an upstream-compatible interface:

1. determine whether the change is necessary;
2. add compatibility behavior where practical;
3. test representative existing packages;
4. document deliberate incompatibility in `COMPATIBILITY.md`;
5. avoid silent breakage.

Aira-native APIs may be added without forcing Pi packages to use them.

## 9. Testing expectations

At minimum, run tests relevant to the touched subsystem before each checkpoint commit.

Before completing a roadmap phase, run:

- unit tests;
- type checks;
- lint/format checks where configured;
- integration tests for affected host behavior;
- compatibility tests when package APIs are touched.

Do not commit known regressions without clearly recording why.

## 10. Commit quality

Good commits are:

- focused;
- understandable;
- reversible;
- tested;
- named after the behavior they introduce.

Avoid messages like:

```text
updates
fix stuff
phase 3
wip final final
```

Prefer conventional-style messages where useful:

```text
feat(core): add Aira session state
fix(plan): block project writes in plan mode
refactor(paths): centralize Aira home resolution
test(compat): cover Pi extension loading
docs(architecture): record browser provider boundary
```

## 11. Check before committing

Recommended routine:

```bash
git status
git diff
# run relevant test/type/lint commands
git diff --check
git add <intentional files>
git diff --cached
git commit -m "..."
```

Do not blindly `git add .` when generated files, credentials, caches, or unrelated changes may exist.

## 12. Never push secrets

Before the first GitHub push, inspect the entire outgoing history and repository for:

- API keys;
- auth/session data;
- `.env` files;
- machine-specific credentials;
- personal browser profiles;
- private logs;
- generated databases;
- tokens embedded in test fixtures.

Aira's `.gitignore` should cover runtime state under `~/.aira/` and project-local sensitive files where appropriate.

## 13. Agent behavior

When an AI agent develops Aira, its instructions should explicitly include:

```text
- inspect before editing;
- preserve Pi compatibility unless a deliberate decision says otherwise;
- keep Aira implementation isolated from upstream-derived code;
- run relevant verification;
- make local Git commits at coherent working checkpoints;
- do not push;
- do not publish packages;
- do not rewrite Git history unless explicitly requested;
- stop/escalate when an architectural invariant would be violated.
```

## 14. Release identity

Aira versions independently from Pi.

Example:

```text
Aira 0.1.0
Pi base: <version/commit>
```

Suggested tags:

```text
aira-v0.1.0
aira-v0.2.0
```

Each release should record the upstream Pi base for future synchronization/debugging.

## 15. Development rule of thumb

If a change is large enough that losing it would be annoying, it is large enough to deserve a local commit once it works.
