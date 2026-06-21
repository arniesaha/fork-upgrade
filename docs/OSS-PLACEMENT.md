# OSS placement & rebrand proposal

Status: proposal (pre-1.0). Captures the naming, distribution, and packaging
decisions for taking this tool public. Nothing here is shipped yet.

## Name: `forklift`

Rebrand the package to **`forklift`** — it evokes lifting a fork onto a new base,
is short, and is npm-plausible as an unscoped name. Drop the personal
`@arniesaha/` scope in favor of a neutral, unscoped package so the tool reads as
community infrastructure rather than one person's utility.

- **Package name:** `forklift` (unscoped). Fallbacks if taken: `rebaseline`,
  `upfork`.
- **CLI command stays `fork-upgrade`.** That is already what the docs, examples,
  and the planned skill shell out to, and what users have muscle memory for.
  Renaming the binary would churn every config and runbook for no real gain. The
  package is `forklift`; the command it installs is `fork-upgrade`.

## Distribution: both, CLI as the single source of truth

Ship through **both** channels, but the CLI is the one implementation; both
channels are thin wrappers that shell out to the installed `fork-upgrade` binary.
Neither reimplements git or rebase logic.

1. **Claude Code marketplace skill (primary).** The real value of this tool is
   orchestration *judgment* — when to carry vs. drop a commit, how to read a
   RED probe, when to roll back — and that is exactly what a skill encodes. The
   design already follows the `docs/superpowers/` convention. This is the
   primary surface.
2. **ClawHub registration (secondary).** OpenClaw forkers are the natural first
   audience (the tool was extracted from an OpenClaw fork workflow), so register
   there too. Also a thin wrapper over the CLI.

Single source of truth means: a bug fix or new phase lands once, in the CLI, and
both wrappers inherit it. The wrappers carry intent and defaults, not logic.

## Skill shape

```
forklift/
  SKILL.md            # frontmatter: name: forklift; description with trigger
  references/
    carry-manifest.md # carry-manifest semantics (sha/subject/upstream_pr/...)
    multi-tag-ladder.md # the multi-tag ladder model (see issue #1)
  examples/
    openclaw/         # the .fork-upgrade.toml + .fork-upgrade-carry.toml configs
```

- `SKILL.md` documents **intent** and shells out to the installed CLI. It does
  not reimplement git logic.
- The skill **never passes `--yes`** in a way that would skip the rollback
  prompt. Destructive recovery requires explicit human input; that invariant is
  part of the tool's contract and the skill must preserve it.
- `references/` holds the durable conceptual material: carry-manifest semantics
  and the multi-tag ladder. `examples/openclaw/` ships the worked configs.

## License & attribution

- **MIT, unchanged.**
- The example carry manifest must use only **public commit subjects**. No
  secrets, and never the live `~/.openclaw/openclaw.json` contents — no
  `proxyUrl`, no credentials, no state archive paths that leak an install
  layout. The shipped `examples/openclaw/.fork-upgrade-carry.toml` already
  follows this (subjects + PR numbers only, placeholder SHAs).

## Reconciling with the existing design docs

The original design lives on the OpenClaw fork branch `agentweave/v2026.5.7`:

- `docs/superpowers/plans/2026-05-07-fork-upgrade-skill.md`
- `specs/2026-05-07-fork-upgrade-skill-design.md`

Most of that design carries forward unchanged. The one genuine departure:

> The spec lists **multi-tag jumps as a non-goal.** The first real run
> (v2026.5.26 → v2026.6.9) spanned ~7 stable tags / 8,201 commits — multi-tag is
> now the *dominant* use case, not an edge case. Promote it from non-goal to the
> top-priority feature (issue #1).

Everything else (gated checkpoints, carry-list intelligence, never-auto-confirm
rollback, the doctor probe integration) is consistent with the original design.
