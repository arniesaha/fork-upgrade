# M2 — Multi-tag ladder + resume (design)

Date: 2026-06-22
Status: approved design, pre-implementation
Issues: #1 (multi-tag ladder), #2 (--resume)
Branch: `feat/m2-multi-tag-ladder`

## Motivation

The first real run (OpenClaw v2026.5.26 → v2026.6.9) spanned ~7 stable tags /
8,201 upstream commits. v0.1 only models a single-tag jump, so the dominant
real-world case — crossing several upstream releases at once — is unsupported.
M2 makes the tool **walk the intermediate stable tags** between the fork's
current base and the target, validating carries + gates at each hop so a
breaking upstream bump is localized to the exact tag that introduced it, and
adds **`--resume`** so a long multi-hop run can recover from an interruption
instead of restarting.

This is the headline feature. M1 (carry safety) is merged; M3 (gate/probe
trust), M4 (ops ergonomics), and M5 (brand & publish) remain out of scope.

## Scope

Three units:

| Unit | Issue | One-line |
| --- | --- | --- |
| A | #1 | Ladder resolution: detect base, enumerate + order + filter tags in `(base, target]`. |
| B | #1 | Ladder orchestration: walk hops; intermediate = branch+carries+integrity+gates (fail-fast); final = +cutover+probes+rollback. |
| C | #2 | `--resume`: re-enter the phase machine at the journaled hop+phase; refuse on a divergent working tree. |

Non-goals (tracked elsewhere): rerere conflict batching (#4), out-of-band
`--rollback` (#5), `--report` (#8), isolated-cache gates (#10), config-migration
probe (#11), doctor drift probe (#6), the forklift rebrand and kits (M5).

## Key decisions (from brainstorming)

1. **Independent validation hops.** Each intermediate tag gets its own branch off
   that tag, the full carry set cherry-picked onto it, then carry-integrity +
   gates. Only the **final** tag's branch becomes the cutover deliverable. This
   localizes which upstream bump breaks carries/gates. Backup is taken **once**
   at the start; it is the rollback target for the whole run.
2. **Base auto-detection with override.** Default base = `git describe --tags
   --abbrev=0` against the upstream tags reachable from the fork's current HEAD;
   `--from-tag <tag>` overrides.
3. **Automatic laddering, `--single-tag` opt-out.** No config toggle: laddering
   is the default. If the resolved ladder is a single tag (target already
   adjacent to base), behavior is identical to v0.1. `--single-tag` skips
   enumeration and jumps directly to the target (the old behavior, explicitly).
4. **Pre-releases excluded by default.** A configurable
   `[upstream].prerelease_pattern` (default `(?i)-(rc|alpha|beta|pre)`) drops
   pre-release tags from the ladder.
5. **`--resume` included in M2, refuses on divergence.** The ladder needs a
   richer journal (hop index + phase) anyway; resume reads that same journal and
   refuses if the working tree is dirty or HEAD is not on the journaled hop
   branch.

## Unit A — Ladder resolution (#1)

**New file `src/ladder.ts`.**

```ts
export type LadderResolution = { base: string; ladder: string[] };

// Pure, git-free: unit-testable. tags = caller-provided list (already the
// raw `git tag` output for tag_pattern). Returns tags in (base, target],
// version-ordered ascending, pre-releases removed.
export function filterAndOrderTags(
  tags: string[],
  params: { base: string; target: string; prereleasePattern: string },
): string[];

// Git-backed: detects base (if fromTag absent) and enumerates the ladder.
export async function resolveLadder(params: {
  repoDir: string;
  upstreamRemote: string;     // unused for tag listing but kept for symmetry/fetch
  tagPattern: string;         // e.g. "v*"
  prereleasePattern: string;
  fromTag?: string;
  target: string;
}): Promise<LadderResolution>;
```

- **Version ordering.** `resolveLadder` lists tags with
  `git tag --list <tagPattern> --sort=v:refname` (git's built-in version sort,
  correct for both semver `v1.2.3` and calendar `v2026.5.26` styles), then hands
  the ordered list to `filterAndOrderTags`. `filterAndOrderTags` preserves the
  caller's order (does not re-sort) and only filters; this keeps the pure
  function free of version-parsing logic while git owns ordering.
- **Base detection.** If `fromTag` is set, `base = fromTag`. Else
  `base = git describe --tags --abbrev=0 --match <tagPattern>` run at HEAD in
  `repoDir` (the newest upstream tag that is an ancestor of HEAD). If `describe`
  fails (no reachable tag, shallow clone), throw a clear error instructing the
  user to pass `--from-tag`.
- **Range.** `filterAndOrderTags` returns tags strictly greater than `base` and
  up to and including `target` (`(base, target]`), with any tag matching
  `prereleasePattern` removed. `target` itself is included even if it would match
  the pre-release pattern (you asked for it explicitly) — i.e. the pre-release
  filter applies only to *intermediate* tags, never the explicit target.
- **Validation.** If `target` is not in the listed tags → throw. If the
  resulting ladder is empty (target == base or target precedes base) → throw a
  clear error (nothing to do / target not ahead of base).

**Config (`src/config.ts`).** Add to the `upstream` block:

```ts
prerelease_pattern: z.string().default("(?i)-(rc|alpha|beta|pre)"),
```

(Additive; existing configs parse unchanged.)

## Unit B — Ladder orchestration (#1)

**Refactor `src/index.ts`.** New CLI flags via `parseArgs`:

- `--from-tag <tag>` (string, optional) — override base detection.
- `--ladder-stop-at <tag>` (string, optional) — halt the run after the hop for
  this tag completes (treat it as the final hop: it gets cutover+probes).
- `--single-tag` (boolean, default false) — skip enumeration; ladder = `[target]`.

**Flow.**

1. **Preflight (once, no mutation):** `resolveCarryList` → `assertCarryShasExist`
   → advisories (all as in M1) → resolve the ladder. With `--single-tag`,
   `ladder = [target]`; otherwise `resolveLadder(...)`. If `--ladder-stop-at` is
   set, truncate the ladder after that tag (error if the tag is not in the
   ladder). Print the resolved ladder. Return here on `--dry-run`.
2. **Backup (once):** `runBackup` exactly as today, before the first hop.
3. **Walk hops:** for each `tag` at index `i` in the ladder, with
   `final = (i === ladder.length - 1)`, run `runHop(tag, { final })`.
4. **`done`** after the final hop.

**`runHop(tag, { final })`** (extracted helper holding the per-hop phases):

- Journal `{ phase: "branch", tag: target, hopTag: tag, ladder, ladderIndex: i }`.
- `branchAndCherryPick({ repoDir, newBranch: substitute(branch_pattern, { tag }),
  baseRef: tag, shas: carry.kept.map(c => c.sha), onConflict })` → `emptyPicks`.
- `verifyCarryIntegrity` over `carry.kept` + `emptyPicks`:
  - **Intermediate hop:** print findings loudly as warnings; do **not** prompt
    (validation only) and continue.
  - **Final hop:** the M1 integrity checkpoint (prompt proceed/abort, `--yes`
    proceeds, findings journaled to `notes`).
- Journal `phase: "gates"`; run gates.
  - **Gates fail (any hop):** print the failing command + tail and **exit 2**,
    naming the hop tag (`gate failed at hop <tag>: <cmd>`). For an intermediate
    hop, leave its branch on disk for inspection (do not delete).
- **Intermediate hop, gates pass:** delete the hop branch
  (`git branch -D <hopBranch>`) — it was throwaway validation — and return. (The
  working tree is left checked out on the hop branch's tip; the next hop's
  `git checkout -b` from the upstream `tag` moves off it before deletion. Order:
  check out the next ref / the deletion happens from a safe ref. See Error
  handling.)
- **Final hop, gates pass:** the existing gates→cutover checkpoint (prompt,
  `--yes`), `phase: "cutover"` + `runCutover`, `phase: "probes"` + `runProbes`,
  RED-rollback (prompt, never `--yes`), then `phase: "done"`.

**Branch lifecycle detail.** `branchAndCherryPick` runs `git checkout -b
<hopBranch> <tag>`. To delete a passing intermediate branch safely, the
orchestrator first checks out the upstream `tag` (detached) — `git checkout
<tag>` — then `git branch -D <hopBranch>`. The next hop's own `checkout -b` then
proceeds from a clean state. A failed intermediate hop skips deletion (branch
kept for debugging) and the run exits.

## Unit C — `--resume` (#2)

**State (`src/state.ts`).** Extend `State` (all optional, additive):

```ts
ladder?: string[];
ladderIndex?: number;
hopTag?: string;
```

`writeState` already spreads `...state`, so these flow through. Every hop/phase
boundary in Unit B writes `ladder`, `ladderIndex`, and `hopTag` alongside the
existing `phase`/`tag`/`forkBranch`.

**`--resume` flag (`src/index.ts`).** When passed:

1. `readState(stateFile)`; if absent → error ("no journal to resume from").
2. **Divergence refusal.** Refuse (exit 2, clear message) if:
   - the working tree is dirty (`git status --porcelain` non-empty), or
   - the current branch is not the journaled hop branch
     (`substitute(branch_pattern, { tag: state.hopTag ?? state.tag })`).
   This prevents replaying onto unexpected content.
3. **Re-enter.** Reconstruct `ladder`/`ladderIndex` from state (fall back to a
   single-tag ladder `[state.tag]` for pre-M2 journals that lack ladder fields).
   Skip preflight enumeration and backup (already done), and resume the hop walk
   at `ladderIndex`, entering `runHop` at the journaled `phase` (a hop resumed
   mid-phase re-runs from the start of that phase — phases are idempotent:
   re-branching uses `git checkout -B`, gates/cutover/probes are repeatable).
   Carries are re-resolved in preflight (cheap, deterministic) so `runHop` has
   `carry.kept`.

**Idempotency note.** Re-running a phase must be safe. `branchAndCherryPick`
gains an optional `force?: boolean` (default false) that selects
`git checkout -B` instead of `-b`. The resume path passes `force: true` so a
half-built hop branch is force-recreated cleanly from the upstream tag before
carries re-apply; the normal (non-resume) path keeps `-b` unchanged. Gates,
cutover, and probes are already repeatable, so re-entering at the start of any
phase is safe.

## Error handling & invariants

- **No mutation before the ladder resolves.** Enumeration + base detection +
  target validation all happen in preflight; any failure exits before backup.
- **Backup once.** The anchor tag / config snapshot is taken a single time before
  the first hop and is the rollback target for the entire run.
- **Fail-fast localization.** An intermediate gate failure exits non-zero naming
  the breaking tag and leaves that hop branch on disk; no cutover occurs.
- **Cutover only on the final hop** (or the `--ladder-stop-at` hop, which becomes
  the final hop).
- **Rollback prompt stays the only never-auto-confirmed gate.**
- **Resume never replays onto a divergent tree** (dirty tree or wrong branch →
  refuse).
- **Backward compatibility.** A ladder of length 1 reproduces v0.1 behavior;
  `--single-tag` forces it. Pre-M2 journals (no ladder fields) resume as a
  single-tag ladder.

## Testing

**Unit (`src/ladder.ts`):**
- `filterAndOrderTags`: given an ordered tag list, returns `(base, target]`;
  excludes pre-releases among intermediates; includes an explicitly-targeted
  pre-release; preserves input order; empty result when target == base.
- `resolveLadder` (real temp git repo): tags `v1,v2,v2.1-rc,v3`, HEAD on `v1`,
  target `v3` → base `v1`, ladder `[v2, v3]` (rc excluded). With `fromTag`
  override. Error when target absent / not ahead of base.

**Unit (`src/state.ts`):** ladder fields round-trip through write/read.

**Integration (`tests/integration/`):**
- *Ladder happy path*: fixture upstream tagged `v1,v2,v2.1-rc,v3`, fork on `v1`,
  run `--tag v3 --yes` → output shows hops `v2` then `v3`, rc excluded, "probes:
  GREEN" appears once (final hop only), and `fork/v3` branch exists at the end.
- *`--single-tag`*: same fixture, `--tag v3 --single-tag --yes` → branches
  directly off `v3`, no intermediate `v2` hop in output.
- *Resume*: write a journal pinned mid-ladder (`ladderIndex` at the final hop,
  `phase: "gates"`) with HEAD on the matching hop branch, run `--resume --yes` →
  completes from that hop (GREEN) without re-running earlier hops; and a
  divergence case (dirty tree or wrong branch) → exit 2 with the refusal message.

**Existing tests:** the M1 happy-path/rollback fixtures put the fork on `v1` with
target `v2` (adjacent) → ladder length 1 → unchanged behavior; they must stay
green. Where a test’s intent is the single-tag path, it may add `--single-tag`
to assert that opt-out explicitly, but should not need changes to keep passing.

## Build/test gate

`npm run build` clean and the full vitest suite green before any PR.
