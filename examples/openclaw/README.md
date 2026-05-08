# OpenClaw fork-upgrade example

Worked example for upgrading a fork of [openclaw/openclaw](https://github.com/openclaw/openclaw) to a new upstream tag.

## What's here

- `.fork-upgrade.toml` — orchestrator config tuned to OpenClaw's gates, cutover, and post-upgrade probe (`openclaw doctor --post-upgrade --json`).
- `.fork-upgrade-carry.toml` — declared carry commits over upstream (two as of v2026.5.7).

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
