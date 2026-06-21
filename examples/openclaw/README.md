# OpenClaw fork-upgrade example

Worked example for upgrading a fork of [openclaw/openclaw](https://github.com/openclaw/openclaw) to a new upstream tag.

## What's here

- `.fork-upgrade.toml` — orchestrator config tuned to OpenClaw's gates, cutover, and post-upgrade probe (`openclaw doctor --post-upgrade --json`).
- `.fork-upgrade-carry.toml` — declared carry commits over upstream (the real 12-commit clientContext/diagnostics-otel stack as of the v2026.6.9 run).

## First real run (v2026.5.26 → v2026.6.9, 2026-06-21)

The first end-to-end run against this config upgraded the OpenClaw fork from
v2026.5.26 to v2026.6.9. It surfaced several things worth recording for anyone
following this example:

- **The jump spanned ~7 stable tags / 8,201 upstream commits** (5.26 → 5.27 →
  5.28 → 6.1 → 6.5 → 6.6 → 6.8 → 6.9), not a single-tag hop. v0.1 only models a
  single-tag jump; multi-tag ladder support is the top open issue (#1).
- **A carry was silently dropped by git's auto-merge.** Upstream had
  restructured `src/infra/diagnostic-events.ts`; git auto-merged with no
  conflict marker and dropped a carried export. Caught only by accident →
  motivates post-rebase carry-integrity verification (#9).
- **Gates false-passed against a polluted module cache.** A worktree sharing the
  parent's `node_modules` + vitest fs module cache passed 6/6 against a stale
  module that still had the dropped symbol → isolated-cache gate execution (#10).
- **The upgraded gateway crash-looped on stricter config validation.** v2026.6.9
  renamed a provider (`models.providers.openai-codex` → `openai`); the old
  `~/.openclaw/openclaw.json` failed validation. Fix was `openclaw doctor --fix`,
  which needed two passes → config-migration probe in cutover/probes (#11).
- **The carry set was 12, not the 11 we expected.** A "parked WIP" commit turned
  out to be load-bearing (the live `dist/` was built with it). It is carried
  unconditionally in the manifest here, with a comment explaining why.

The clientContext pivot from this run is upstream PR
[openclaw/openclaw#95608](https://github.com/openclaw/openclaw/pull/95608); the
`onModelDiagnosticEvent` carry is [#80497](https://github.com/openclaw/openclaw/pull/80497).

## How to use

1. Copy both files to the root of your OpenClaw fork checkout.
2. Adjust `backup.config_files` and `state_archive` if your install lives somewhere other than `~/.openclaw/`.
3. Adjust `cutover.restart` for your platform (systemd unit on Linux, `launchctl` or `pnpm gateway:watch` elsewhere).
4. Update `.fork-upgrade-carry.toml` to match your fork's actual carry list.
5. From the fork checkout, run:

   ```
   fork-upgrade --tag v<NEW_TAG> --upstream-repo openclaw/openclaw
   ```

The orchestrator will: anchor a rollback tag and push it, snapshot config + state, branch off the new upstream tag, cherry-pick non-merged carry commits, run gates, restart the gateway, and run the doctor probe. If probes return RED, you'll be prompted to roll back.

## Manual equivalent

The same workflow as a runbook lives at `docs/superpowers/specs/2026-05-07-openclaw-v2026.5.7-upgrade-and-bridge-fix.md` in the OpenClaw fork (worked example for the v2026.5.2 → v2026.5.7 upgrade).
