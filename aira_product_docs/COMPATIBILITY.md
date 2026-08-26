# Aira ↔ Pi Compatibility

Aira is a standalone product derived from Pi. Compatibility exists to preserve the value of the Pi ecosystem while allowing Aira to provide a more integrated default experience.

## Compatibility principle

> **Aira speaks Pi, but Aira owns its world.**

Pi compatibility is a platform contract. It is not a requirement that Aira copy Pi's UX, filesystem layout, defaults, or command surface exactly.

## Canonical Aira behavior

Aira owns:

```text
executable       aira
home             ~/.aira/
settings         Aira settings
sessions         Aira sessions
UX               Aira UX
modes            Aira BUILD/PLAN/REVIEW
orchestration    Aira
policy           Aira
updates          Aira
```

Normal Aira operation must not depend on `~/.pi/`.

## Compatibility targets

Aira should preserve wherever practical:

### Extensions

Existing Pi extensions should load without source modification when they use supported Pi extension APIs.

### Skills

Pi-compatible skills should remain discoverable/loadable.

### Themes

Existing Pi themes should remain usable unless a documented Aira UI requirement makes a particular theme incompatible.

### Packages

Preserve familiar package sources where practical:

```text
npm:<package>
git:<repository>
local paths
```

Desired UX:

```bash
aira install npm:pi-lens
aira install git:github.com/example/package
```

### Models/providers

Pi-compatible model/provider configuration should remain supportable unless Aira deliberately replaces an interface.

### Extension lifecycle

Where Aira changes host lifecycle behavior, compatibility events should continue to behave consistently enough for existing extensions.

## Filesystem compatibility

Aira does not use `~/.pi/` as its canonical home.

Aira layout (Pi-compatible internal shape preserved under the Aira root):

```text
~/.aira/                    canonical home
└── agent/                  settings, sessions, cache, extensions, skills,
                            themes, prompts, agents, tools, keybindings,
                            trust, logs
```

Project-local resources use `<cwd>/.aira/` (not `<cwd>/.pi/`).

Migration flow (optional and explicit):

```bash
existing ~/.pi/agent          aira import --pi            ~/.aira/agent
```

`aira import --pi` copies supported resources (settings, keybindings, models,
model store, trust, themes, skills, prompts, extensions, agents, tools, `bin`,
sessions). Credentials (`auth.json`) are excluded unless
`--include-secrets`; existing Aira resources are preserved unless `--force`;
`--dry-run` previews the plan; a successful import writes `~/.aira/migration.json`.
Migration copies rather than moves, never making Aira permanently depend on Pi's
directory.

## CLI compatibility

Aira's canonical CLI is:

```text
aira
```

The npm package also ships `pi` as a compatibility alias to the same binary, so
existing Pi-oriented scripts keep working.

Pi command names may be preserved where they are useful, but Aira is free to simplify or improve the primary UX.

Compatibility aliases should not prevent Aira from introducing native commands such as:

```text
aira doctor
aira install
aira update
aira models
```

## Behavioral divergence

Aira may deliberately diverge from Pi when the change is central to the product.

Expected examples:

- `Shift+Tab` controls Aira modes;
- Aira may route tools/capabilities automatically;
- Aira may enforce stronger project boundaries;
- Aira may alter compaction to preserve engineering state;
- Aira may provide different default permission behavior;
- Aira may integrate diagnostics/browser/verification natively;
- Aira may hide routine extension commands from normal workflow.

Such divergence should be documented and tested.

## Compatibility layers

Prefer explicit compatibility adapters:

```text
Pi package
    ↓
compat/pi
    ↓
Aira runtime
```

over leaking Pi-specific assumptions through native Aira subsystems.

## Compatibility testing

Maintain representative fixtures/packages covering:

- basic extension registration;
- lifecycle events;
- tool registration;
- commands;
- skills;
- themes;
- package installation;
- settings;
- provider/model behavior.

Every upstream Pi sync that touches public extension/package behavior should run this suite.

## Compatibility levels

Aira may eventually document support using levels:

```text
Compatible
Works without modification.

Compatible with limitations
Core behavior works; documented Pi-specific behavior differs.

Aira-enhanced
Works as a Pi package and optionally uses native Aira APIs.

Unsupported
Relies on behavior Aira deliberately does not implement.
```

## Aira-native extensions

Future extensions may optionally target native Aira APIs such as:

```text
aira.project
aira.supervision
aira.tasks
aira.browser
aira.capabilities
```

These APIs should be additive. A package should not need to become Aira-native merely to remain Pi-compatible.

## No silent compatibility promises

When Aira cannot reasonably preserve a Pi behavior, document it here rather than carrying fragile hacks indefinitely.

Compatibility is important; architectural integrity is more important than pretending every upstream behavior is identical forever.
