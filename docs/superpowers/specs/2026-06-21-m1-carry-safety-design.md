# M1 — Carry safety & correctness (design)

Date: 2026-06-21
Status: approved design, pre-implementation
Issues: #13, #7, #3, #9
Branch: `feat/m1-carry-safety`

## Motivation

The first real run of this tool (OpenClaw v2026.5.26 → v2026.6.9) silently
**dropped a carried export**: upstream restructured a file, git auto-merged with
no conflict marker, the cherry-pick "succeeded", and a carried symbol vanished —
caught only by accident. A fork-maintenance tool that can silently lose your
customizations is not trustworthy enough to publish. M1 makes the carry set
**provably correct** before any later milestone builds on it.

M1 is the first iteration of a larger roadmap (M2 multi-tag ladder, M3 gate/probe
trust, M4 ops ergonomics, M5 brand & publish). Those are out of scope here and
remain tracked in their own issues.

## Scope

Four independent, separately-testable units centered on the carry manifest:

| Unit | Issue | One-line |
| --- | --- | --- |
| A | #13 | Preflight guard: every kept carry SHA must resolve before any mutation. |
| B | #7  | `enabled` (park) and `pin` (never-auto-skip) carry fields. |
| C | #3  | `upstream_search` advisory query (informational, never auto-skips). |
| D | #9  | Post-replay carry-integrity: empty-commit net + declared `landed_markers`. |

Non-goals (deferred, tracked elsewhere): multi-tag/ladder (#1), `--resume` (#2),
isolated-cache gates (#10), config-migration probe (#11), doctor drift probe
(#6), rerere batching (#4), out-of-band rollback (#5), `--report` (#8), the
forklift rebrand and kit packaging (M5).

## Schema additions

All additive and backward-compatible (existing manifests parse unchanged). In
`CarryEntrySchema` (`src/carry-manifest.ts`):

```toml
[[commits]]
sha = "<short or full SHA>"
subject = "<commit subject>"
upstream_pr = ""              # existing: skip-if-merged
upstream_search = ""          # existing field, now actively queried (Unit C)
enabled = true                # NEW. default true. false = parked (shown, skipped).
pin = true                    # NEW. default false. true = never auto-skip.
landed_markers = ["symbol"]   # NEW. default []. strings that must exist post-replay.
```

Zod definitions:
- `enabled: z.boolean().optional().default(true)`
- `pin: z.boolean().optional().default(false)`
- `landed_markers: z.array(z.string()).optional().default([])`

## Unit A — Preflight SHA existence guard (#13)

**Problem.** Carry SHAs flow straight into `git cherry-pick` with no validation.
A stale or placeholder SHA (e.g. the example's `REFRESH-NN`) fails only at the
cherry-pick step — *after* backup and branch have already mutated the repo
(anchor tag pushed, config/state snapshotted, new branch created).

**Design.** New function in `src/carry-manifest.ts`:

```ts
export async function assertCarryShasExist(params: {
  repoDir: string;
  entries: CarryEntry[];
}): Promise<{ ok: boolean; missing: CarryEntry[] }>
```

For each entry, run `git rev-parse --verify --quiet <sha>^{commit}`. A non-zero
exit (or empty stdout) means the SHA does not resolve to a commit. Returns the
list of unresolved entries.

**Wiring (`src/index.ts`).** Call immediately after `resolveCarryList`, passing
only the `kept` carries (parked/landed are not cherry-picked), and **before** the
`--dry-run` early return — so a dry run previews bad SHAs too. On `missing.length
> 0`: print each `sha — subject`, a pointer to the manifest, and `process.exit(2)`.
No backup, branch, or snapshot has run at this point.

**Tests** (`tests/unit/carry-manifest.test.ts` or a new file, using the temp-git
fixtures): a real SHA passes; a fabricated SHA is reported in `missing`.

## Unit B — `enabled` + `pin` carry fields (#7)

**Problem.** A carry cannot be parked without deletion, and there is no way to
mark a commit that is **deployed but not yet PR'd** so it is never auto-skipped
(the load-bearing "carry 12" from the real run).

**Design.** `ResolvedCarryList` gains a `parked` bucket:

```ts
export type ResolvedCarryList = {
  kept: CarryEntry[];
  landed: CarryEntry[];
  parked: CarryEntry[];   // NEW
};
```

`resolveCarryList` per-entry logic, in order:
1. `enabled === false` → `parked` (never cherry-picked; shown in preflight).
2. `pin === true` → `kept` unconditionally (skip the `upstream_pr` merged check).
3. else existing: `upstream_pr` set and merged → `landed`; otherwise → `kept`.

**Wiring (`src/index.ts`).** Print the parked bucket in the preflight summary,
e.g. `carry parked (disabled): <sha> …`. Pinned carries appear in `kept` as
today; optionally annotate them as pinned in the printed line.

**Example manifest.** Update `examples/openclaw/.fork-upgrade-carry.toml` carry
12 to `upstream_pr = "95608"` + `pin = true` — documents the family PR for
traceability while guaranteeing the load-bearing commit is never dropped. Update
its comment to describe `pin` instead of the "leave upstream_pr empty" workaround.

**Tests.** A `enabled = false` entry lands in `parked` and not in `kept`/`landed`;
a `pin = true` entry with a *merged* `upstream_pr` still lands in `kept` (not
`landed`).

## Unit C — `upstream_search` advisory query (#3)

**Problem.** `upstream_search` is documented but inert; only `upstream_pr` drives
any check. Carries without a PR number have no signal that an equivalent change
may have landed upstream.

**Design.** New function in `src/carry-manifest.ts`, with an injectable search
fn mirroring `GhPrStateFn` for testability:

```ts
export type GhSearchFn = (query: string, upstreamRepo: string) => Promise<GhSearchHit[]>;
export type GhSearchHit = { sha: string; url: string; subject: string };

export async function searchUpstreamForCarries(params: {
  entries: CarryEntry[];          // typically the `kept` carries
  upstreamRepo: string;
  ghSearch: GhSearchFn;
}): Promise<Array<{ entry: CarryEntry; hits: GhSearchHit[] }>>
```

For each entry with a non-empty `upstream_search`, call `ghSearch`. The CLI
implementation `ghSearchFromCli` runs
`gh search commits --repo <upstreamRepo> "<query>" --limit 3 --json sha,url,...`
and, like `ghPrStateFromCli`, swallows failures (returns `[]`) so a missing/offline
`gh` never breaks the run. **This never moves a carry** — it only produces
advisories.

**Wiring (`src/index.ts`).** In preflight, after resolution, print one advisory
line per entry with hits: `advisory: carry <sha> "<subject>" may have landed
upstream — N match(es): <urls>`. Runs before the `--dry-run` return so dry runs
show advisories.

**Tests.** `ghSearch` mock returning a hit produces an advisory; the resolved
`kept`/`landed` lists are unchanged regardless of search results.

## Unit D — Carry-integrity verification (#9)

**Problem.** A successful cherry-pick exit code does not prove the carry's content
is present. Two distinct failure shapes:
- **Full absorption** — the carry's changes are already entirely upstream; the
  cherry-pick reports "now empty". Today this fails with no conflicted files,
  hits the conflict path, and aborts the run with a misleading message.
- **Partial drop** — git auto-merges an upstream restructure and silently drops
  one added line/symbol while applying the rest. The commit is non-empty, so only
  content-level inspection catches it.

**Design — two mechanisms, surfaced together.**

1. **Empty-commit net (`src/branch.ts`).** `branchAndCherryPick` returns
   `{ emptyPicks: string[] }` instead of `void`. When a `git cherry-pick <sha>`
   fails with **no conflicted files** and the failure is the empty/absorbed case
   (stderr indicates "empty", or `git diff --cached --quiet` reports no staged
   change), record the sha in `emptyPicks` and run `git cherry-pick --skip` to
   continue, rather than invoking `onConflict`. Genuine conflicts (non-empty
   `--diff-filter=U` set) keep the existing `onConflict` behavior unchanged.

2. **Declared markers (`src/carry-manifest.ts` or new `src/carry-integrity.ts`).**

   ```ts
   export type IntegrityFinding = {
     sha: string; subject: string;
     kind: "missing-marker" | "empty-pick";
     detail: string;
   };
   export async function verifyCarryIntegrity(params: {
     repoDir: string;
     carries: CarryEntry[];      // the kept carries that were replayed
     emptyPicks: string[];       // from branchAndCherryPick
   }): Promise<IntegrityFinding[]>
   ```

   For each kept carry with `landed_markers`, `git grep -F -- "<marker>"` in the
   working tree (current branch); a marker with no match yields a
   `missing-marker` finding. Each sha in `emptyPicks` yields an `empty-pick`
   finding.

**Wiring (`src/index.ts`).** After the branch phase, run `verifyCarryIntegrity`.
If findings exist, print them loudly (one line each). Then a new checkpoint,
consistent with the existing gates checkpoint:
- not `--yes` → prompt `proceed | abort`;
- `--yes` → proceed, but the findings remain printed and are written into the
  journal/state for the run record.

This satisfies the acceptance criterion: a carry whose addition is silently lost
is flagged **before cutover**, not discovered later.

**Tests.**
- Unit: `verifyCarryIntegrity` returns a `missing-marker` finding when a declared
  marker is absent and none when present; an `emptyPicks` sha yields an
  `empty-pick` finding.
- Unit (`branch.ts`): a carry whose changes are already present is recorded in
  `emptyPicks` and skipped (run continues), not routed to `onConflict`.
- Integration: extend the happy-path fixture with a kept carry declaring a
  `landed_markers` value that is absent post-replay; assert the run surfaces the
  finding before the cutover phase.

## End-to-end data flow (`src/index.ts`)

```
preflight
  → resolveCarryList            → { kept, landed, parked }
  → assertCarryShasExist(kept)  → exit 2 if any missing
  → searchUpstreamForCarries    → print advisories
  → [ --dry-run returns here ]
backup
branch (branchAndCherryPick)    → { emptyPicks }
  → verifyCarryIntegrity        → findings
  → integrity checkpoint        → proceed | abort  (--yes proceeds, logs findings)
gates → checkpoint → cutover → probes → (rollback if RED) → done
```

## Error handling & invariants

- No repo mutation occurs before Unit A's guard passes.
- Unit C and the integrity checks never silently change which carries are kept;
  they only inform or warn.
- `gh`-backed calls (`ghPrStateFromCli`, `ghSearchFromCli`) swallow failures and
  degrade to "no information", never aborting the run.
- The integrity checkpoint respects `--yes` for unattended runs but always emits
  the findings; the rollback prompt remains the only never-auto-confirmed gate.

## Testing summary

Per-unit unit tests plus one new integration test (Unit D). No changes to
existing unrelated tests. `npm run build` clean, full suite green, before any PR.
