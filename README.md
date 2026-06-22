# fork-upgrade

Config-driven CLI orchestrator for rebasing a fork onto a new upstream tag, with carry-list intelligence, gated checkpoints, and rollback.

Originally extracted from a real-world fork-maintenance workflow on [openclaw/openclaw](https://github.com/openclaw/openclaw); designed to be reusable across any fork that follows the rebase-onto-upstream-tag pattern.

## Status

v0.1 — orchestrator code, integration tests, and an OpenClaw worked example. Not yet published to ClawHub.

## Quickstart

1. Install:

   ```
   npm install -g @arniesaha/fork-upgrade
   ```

2. From your fork's checkout, create `.fork-upgrade.toml` and `.fork-upgrade-carry.toml`. See `examples/openclaw/` for a worked example.

3. Run:

   ```
   fork-upgrade --tag v<NEW_UPSTREAM_TAG> --upstream-repo <owner/repo> [--yes] [--dry-run]
   ```

The orchestrator runs through these phases, journaling each one to `.fork-upgrade-state.json`:

`preflight → backup → branch → gates → checkpoint → cutover → probes → (rollback if RED) → done`

## Config reference

`.fork-upgrade.toml` blocks:

- `[upstream]` — `remote`, `tag_pattern`, `fetch_before`.
- `[fork]` — `origin_remote`, `branch_pattern` (e.g. `agentweave/{tag}`).
- `[carry]` — `manifest` path to the carry list.
- `[backup]` — `anchor_tag`, `push_anchor`, `config_files[]`, `state_archive { paths, output }`.
- `[gates]` — `install`, `typecheck`, `test` (string or `[string]`), `build`.
- `[cutover]` — `restart`, `verify`.
- `[probes]` — `post_cutover[]` of `{ name, cmd, parse: "json"|"exit", optional }`.
- `[rollback]` — `restart_after`.

Placeholders: `{tag}` and `{fork_branch}` are substituted in any string field.

## Carry manifest

`.fork-upgrade-carry.toml`:

```toml
[[commits]]
sha = "<short or full SHA>"
subject = "<commit subject>"
upstream_pr = "<PR number, optional>"       # if set and merged, orchestrator skips this commit
upstream_search = "<text fallback>"         # actively queried as ADVISORY (never auto-skips)
enabled = true                              # default true; false parks the carry (shown in preflight, skipped from cherry-pick)
pin = false                                 # default false; true carries unconditionally — never auto-skipped even if upstream_pr is set/merged
landed_markers = ["SOME_FUNC", "some-id"]  # strings asserted to exist in tree after replay; missing ones warn at integrity checkpoint
```

## Probes

Each probe runs a shell command. With `parse = "exit"`, exit 0 is `ok` and any non-zero is a finding (`error` if required, `warn` if `optional`). With `parse = "json"`, the probe must emit a JSON envelope shaped `{ findings: [{ level, code, message }] }` on stdout. The orchestrator aggregates all probe findings into a single classification: any `error` → `RED`, any `warn` → `YELLOW`, else `GREEN`.

For OpenClaw forks, point `probes.post_cutover` at `openclaw doctor --post-upgrade --json` (added in OpenClaw v2026.5.x) to surface plugin compat findings as machine-consumable JSON.

## Checkpoints

Three interactive checkpoints by default:

1. After gates pass, before cutover restart.
2. (Implicit, in the cherry-pick conflict path: drop into editor, choose proceed or abort.)
3. If probes return RED, ask whether to roll back.

Pass `--yes` to auto-confirm checkpoint 1. The rollback prompt is intentionally never auto-confirmed — destructive recovery requires explicit human input.

## Rollback

On RED + user-approved rollback, or via the `--rollback` flag (planned), the orchestrator: `git checkout <anchor_tag>`, restores each `config_files[*]` from its `.pre-{tag}` snapshot, optionally re-runs the cutover restart.

## Limitations (v0.1)

- Single-tag jumps only. Multi-tag (e.g. v5.2 → v5.7 across intermediate tags) is not supported.
- Cherry-pick conflicts open `$EDITOR` (your shell's default); auto-resolution is out of scope.
- Cross-platform restart is your config's responsibility — declare the right `cutover.restart` per host (systemd, launchd, supervisor, etc.).
- `upstream_search` in the carry manifest is actively queried as an advisory (results shown in preflight; it never auto-skips a carry). `upstream_pr` triggers the skip check via `gh pr view`.
- `--resume` from a journaled phase is planned; v0.1 writes the journal but doesn't yet replay from it.

## Example

A complete worked example for the OpenClaw fork (the workflow this tool was extracted from) lives in `examples/openclaw/`.

## Development

```
npm install
npm run build
npm test
```

## License

MIT
