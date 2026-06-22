# M2 — Multi-tag Ladder + Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walk the intermediate stable upstream tags between the fork's base and the target — validating carries + gates at each hop, cutting over only on the final hop — and add `--resume` to recover an interrupted multi-hop run.

**Architecture:** A new `src/ladder.ts` resolves the tag ladder (pure `filterAndOrderTags` + git-backed `resolveLadder`). `src/index.ts` is refactored to extract a `runHop` helper and walk the ladder; intermediate hops validate (branch + carries + integrity + gates, fail-fast) and are discarded, the final hop also cuts over and probes. State gains ladder fields so `--resume` can re-enter at the journaled hop+phase. Backup is taken once and is the whole-run rollback target.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥ 18, `@iarna/toml`, `zod`, `execa`, vitest. Tests build real temp git repos.

## Global Constraints

- **Automatic laddering; `--single-tag` opt-out.** A resolved ladder of length 1 reproduces v0.1 behavior exactly. `--single-tag` forces `ladder = [target]` (skips enumeration).
- **Base detection:** `--from-tag <tag>` if given, else `git describe --tags --abbrev=0 --match <tagPattern>` at HEAD; on failure, throw instructing the user to pass `--from-tag`.
- **Range `(base, target]`**, version-ordered by `git tag --list <pattern> --sort=v:refname`.
- **Pre-release filter:** `[upstream].prerelease_pattern` (default `-(rc|alpha|beta|pre)`), compiled `new RegExp(pattern, "i")`. Applies ONLY to intermediate tags — the explicit `target` is never filtered out.
- **Independent validation hops:** each hop branches off its own tag and cherry-picks the full carry set. Backup once before the first hop. Cutover/probes/rollback ONLY on the final hop (the `--ladder-stop-at` tag becomes the final hop).
- **Gates fail-fast:** an intermediate gate failure exits 2 naming the hop tag and leaves that hop branch on disk; a passing intermediate branch is deleted.
- **Rollback prompt stays the only never-auto-confirmed gate.** Intermediate hops never prompt (validation only); the integrity checkpoint and gates→cutover checkpoint apply on the final hop only.
- **`--resume`:** re-enter at journaled hop+phase; refuse (exit 2) on a dirty tree or when HEAD is not on the journaled hop branch. Phases are idempotent; the branch step force-recreates under resume. Pre-M2 journals (no ladder fields) resume as a single-tag ladder.
- **All schema/state additions additive and backward-compatible.**
- **Per the milestone:** `npm run build` clean and full vitest suite green before the PR. Delivery: one M2 PR.

---

## Task 1: `filterAndOrderTags` (pure ladder filter)

**Files:**
- Create: `src/ladder.ts`
- Test: `tests/unit/ladder.test.ts`

**Interfaces:**
- Produces:
  - `type LadderResolution = { base: string; ladder: string[] }`
  - `filterAndOrderTags(tags: string[], params: { base: string; target: string; prereleasePattern: string }): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ladder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filterAndOrderTags } from "../../src/ladder.js";

const PRE = "-(rc|alpha|beta|pre)";

describe("filterAndOrderTags", () => {
  it("returns intermediate+target tags in (base, target], excluding intermediate pre-releases", () => {
    const tags = ["v1", "v2", "v2.1-rc", "v3"];
    expect(filterAndOrderTags(tags, { base: "v1", target: "v3", prereleasePattern: PRE })).toEqual(["v2", "v3"]);
  });

  it("keeps an explicitly-targeted pre-release even though it matches the pattern", () => {
    const tags = ["v1", "v2", "v3.0-rc"];
    expect(filterAndOrderTags(tags, { base: "v1", target: "v3.0-rc", prereleasePattern: PRE })).toEqual(["v2", "v3.0-rc"]);
  });

  it("returns a single-element ladder for an adjacent target", () => {
    const tags = ["v1", "v2"];
    expect(filterAndOrderTags(tags, { base: "v1", target: "v2", prereleasePattern: PRE })).toEqual(["v2"]);
  });

  it("throws when the target is not ahead of the base", () => {
    const tags = ["v1", "v2"];
    expect(() => filterAndOrderTags(tags, { base: "v2", target: "v1", prereleasePattern: PRE })).toThrow(/not ahead/);
  });

  it("throws when the target tag is unknown", () => {
    const tags = ["v1", "v2"];
    expect(() => filterAndOrderTags(tags, { base: "v1", target: "v9", prereleasePattern: PRE })).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ladder`
Expected: FAIL — `src/ladder.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/ladder.ts`:

```ts
export type LadderResolution = { base: string; ladder: string[] };

export function filterAndOrderTags(
  tags: string[],
  params: { base: string; target: string; prereleasePattern: string },
): string[] {
  const { base, target, prereleasePattern } = params;
  const baseIdx = tags.indexOf(base);
  const targetIdx = tags.indexOf(target);
  if (targetIdx === -1) throw new Error(`target tag '${target}' not found among upstream tags`);
  if (baseIdx === -1) throw new Error(`base tag '${base}' not found among upstream tags`);
  if (targetIdx <= baseIdx) throw new Error(`target tag '${target}' is not ahead of base '${base}'`);
  const prerelease = new RegExp(prereleasePattern, "i");
  const ladder: string[] = [];
  for (let i = baseIdx + 1; i <= targetIdx; i++) {
    const t = tags[i];
    // Drop intermediate pre-releases; always keep the explicitly-requested target.
    if (i < targetIdx && prerelease.test(t)) continue;
    ladder.push(t);
  }
  return ladder;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ladder`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ladder.ts tests/unit/ladder.test.ts
git commit -m "feat(ladder): filterAndOrderTags pure range/prerelease filter (#1)"
```

---

## Task 2: `resolveLadder` (git-backed) + config field

**Files:**
- Modify: `src/ladder.ts` (append `resolveLadder`)
- Modify: `src/config.ts` (add `prerelease_pattern` to `upstream`)
- Test: `tests/unit/ladder-resolve.test.ts`

**Interfaces:**
- Consumes: `filterAndOrderTags` (Task 1), `execa`.
- Produces: `resolveLadder(params: { repoDir: string; tagPattern: string; prereleasePattern: string; fromTag?: string; target: string }): Promise<LadderResolution>`

- [ ] **Step 1: Add the config field**

In `src/config.ts`, add to the `upstream` object schema (after `fetch_before`):

```ts
    prerelease_pattern: z.string().default("-(rc|alpha|beta|pre)"),
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/ladder-resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";
import { resolveLadder } from "../../src/ladder.js";

async function repoWithTags(): Promise<{ repo: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "ladder-"));
  await execa("git", ["init", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.email", "t@e.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "t"], { cwd: repo });
  for (const v of ["v1", "v2", "v2.1-rc", "v3"]) {
    await fs.writeFile(path.join(repo, "f.txt"), v, "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", v], { cwd: repo });
    await execa("git", ["tag", v], { cwd: repo });
  }
  // fork branch off v1 with an extra commit (so HEAD's nearest tag is v1)
  await execa("git", ["checkout", "-b", "fork", "v1"], { cwd: repo });
  await fs.writeFile(path.join(repo, "carry.txt"), "c", "utf-8");
  await execa("git", ["add", "."], { cwd: repo });
  await execa("git", ["commit", "-m", "carry"], { cwd: repo });
  return { repo };
}

describe("resolveLadder", () => {
  it("auto-detects the base via git describe and enumerates (base, target], excluding pre-releases", async () => {
    const { repo } = await repoWithTags();
    const res = await resolveLadder({
      repoDir: repo,
      tagPattern: "v*",
      prereleasePattern: "-(rc|alpha|beta|pre)",
      target: "v3",
    });
    expect(res.base).toBe("v1");
    expect(res.ladder).toEqual(["v2", "v3"]);
  });

  it("honors an explicit fromTag override", async () => {
    const { repo } = await repoWithTags();
    const res = await resolveLadder({
      repoDir: repo,
      tagPattern: "v*",
      prereleasePattern: "-(rc|alpha|beta|pre)",
      fromTag: "v2",
      target: "v3",
    });
    expect(res.base).toBe("v2");
    expect(res.ladder).toEqual(["v3"]);
  });

  it("throws when the target tag does not exist", async () => {
    const { repo } = await repoWithTags();
    await expect(
      resolveLadder({ repoDir: repo, tagPattern: "v*", prereleasePattern: "-(rc|alpha|beta|pre)", target: "v9" }),
    ).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- ladder-resolve`
Expected: FAIL — `resolveLadder` is not exported.

- [ ] **Step 4: Implement `resolveLadder`**

Append to `src/ladder.ts`:

```ts
import { execa } from "execa";

export async function resolveLadder(params: {
  repoDir: string;
  tagPattern: string;
  prereleasePattern: string;
  fromTag?: string;
  target: string;
}): Promise<LadderResolution> {
  const { stdout } = await execa(
    "git",
    ["tag", "--list", params.tagPattern, "--sort=v:refname"],
    { cwd: params.repoDir },
  );
  const tags = stdout
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

  let base = params.fromTag;
  if (!base) {
    try {
      const res = await execa(
        "git",
        ["describe", "--tags", "--abbrev=0", "--match", params.tagPattern],
        { cwd: params.repoDir },
      );
      base = res.stdout.trim();
    } catch {
      throw new Error(
        "could not auto-detect the fork's base tag (git describe failed); pass --from-tag <tag>",
      );
    }
  }

  const ladder = filterAndOrderTags(tags, {
    base,
    target: params.target,
    prereleasePattern: params.prereleasePattern,
  });
  return { base, ladder };
}
```

Put the `import { execa } from "execa";` line at the TOP of `src/ladder.ts` (move it above `filterAndOrderTags`), not mid-file.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- ladder-resolve` then `npm test` (full suite — config change must not break existing config tests).
Expected: PASS (3 new tests; full suite green).

- [ ] **Step 6: Commit**

```bash
git add src/ladder.ts src/config.ts tests/unit/ladder-resolve.test.ts
git commit -m "feat(ladder): resolveLadder base detection + enumeration; prerelease_pattern config (#1)"
```

---

## Task 3: `force` flag on `branchAndCherryPick`

**Files:**
- Modify: `src/branch.ts`
- Test: `tests/unit/branch.test.ts` (add a case)

**Interfaces:**
- Produces: `BranchOptions` gains optional `force?: boolean`; when true, the initial checkout uses `git checkout -B` (force-recreate) instead of `-b`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/branch.test.ts` (inside the existing `describe`):

```ts
  it("force-recreates an existing branch when force is true", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "branch-force-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "t"], { cwd: repo });
    await fs.writeFile(path.join(repo, "main.txt"), "main", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "base"], { cwd: repo });
    await execa("git", ["tag", "v1"], { cwd: repo });

    // first run creates fork/v1
    await branchAndCherryPick({ repoDir: repo, newBranch: "fork/v1", baseRef: "v1", shas: [] });
    // second run with force must succeed (recreate), not fail "already exists"
    const result = await branchAndCherryPick({ repoDir: repo, newBranch: "fork/v1", baseRef: "v1", shas: [], force: true });
    expect(result.emptyPicks).toEqual([]);
    const { stdout: branches } = await execa("git", ["branch", "--list", "fork/v1"], { cwd: repo });
    expect(branches).toContain("fork/v1");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- branch`
Expected: FAIL — without `force`, the second `git checkout -b fork/v1` errors "already exists"; `force` is not yet a recognized option.

- [ ] **Step 3: Implement the flag**

In `src/branch.ts`, add `force?: boolean` to `BranchOptions`:

```ts
export type BranchOptions = {
  repoDir: string;
  newBranch: string;
  baseRef: string;
  shas: string[];
  force?: boolean;
  /** Called when a cherry-pick conflicts. Resolve to true to retry, false to abort. */
  onConflict?: (sha: string, conflictedFiles: string[]) => Promise<boolean>;
};
```

Change the initial checkout line in `branchAndCherryPick`:

```ts
  await execa("git", ["checkout", opts.force ? "-B" : "-b", opts.newBranch, opts.baseRef], { cwd: opts.repoDir });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- branch`
Expected: PASS — new force test green; existing branch tests green (default `-b` path unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/branch.ts tests/unit/branch.test.ts
git commit -m "feat(branch): optional force flag to recreate a hop branch (#2)"
```

---

## Task 4: State ladder fields

**Files:**
- Modify: `src/state.ts`
- Test: `tests/unit/state.test.ts` (add a case)

**Interfaces:**
- Produces: `State` gains optional `ladder?: string[]`, `ladderIndex?: number`, `hopTag?: string`. `writeState` already spreads `...state`, so they round-trip with no signature change.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/state.test.ts` (inside the existing `describe`; reuse its existing imports for `writeState`/`readState`, `fs`, `path`, `os`):

```ts
  it("round-trips ladder fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "state-ladder-"));
    const file = path.join(dir, "state.json");
    await writeState(file, {
      phase: "gates",
      tag: "v3",
      forkBranch: "fork/v3",
      ladder: ["v2", "v3"],
      ladderIndex: 1,
      hopTag: "v3",
    });
    const s = await readState(file);
    expect(s?.ladder).toEqual(["v2", "v3"]);
    expect(s?.ladderIndex).toBe(1);
    expect(s?.hopTag).toBe("v3");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- state`
Expected: FAIL — `writeState` rejects the unknown `ladder`/`ladderIndex`/`hopTag` properties at the type level (build/tsc error), or the fields are not present on the `State` read type.

- [ ] **Step 3: Implement the fields**

In `src/state.ts`, extend the `State` type:

```ts
export type State = {
  phase: Phase;
  tag: string;
  forkBranch: string;
  startedAt: number;
  notes?: string[];
  ladder?: string[];
  ladderIndex?: number;
  hopTag?: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/unit/state.test.ts
git commit -m "feat(state): ladder/ladderIndex/hopTag journal fields (#2)"
```

---

## Task 5: Refactor `index.ts` — extract `runHop`, walk a single-hop ladder (behavior-preserving)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: all existing imports. Introduces a module-local `type HopCtx` and `async function runHop(ctx, hopTag, ladderIndex): Promise<boolean>` (returns `false` when a checkpoint aborts the run).
- Produces: identical externally-observable behavior to today (ladder is hardcoded to `[target]`). No new test — existing happy-path/rollback/parked/sha-guard/integrity integration tests must stay green.

- [ ] **Step 1: Rewrite `main` to extract `runHop` and loop over `[tag]`**

Replace the body of `src/index.ts` from `async function main()` through the end of `main` (everything between the imports and the `main().catch(...)` trailer) with:

```ts
type HopCtx = {
  repoDir: string;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  carry: Awaited<ReturnType<typeof resolveCarryList>>;
  stateFile: string;
  yes: boolean;
  target: string;
  ladder: string[];
};

async function runHop(ctx: HopCtx, hopTag: string, ladderIndex: number): Promise<boolean> {
  const { repoDir, cfg, carry, stateFile, yes, target, ladder } = ctx;
  const hopBranch = substitute(cfg.fork.branch_pattern, { tag: hopTag });
  const journalBase = { tag: target, forkBranch: hopBranch, ladder, ladderIndex, hopTag };

  await writeState(stateFile, { phase: "branch", ...journalBase });
  const branchResult = await branchAndCherryPick({
    repoDir,
    newBranch: hopBranch,
    baseRef: hopTag,
    shas: carry.kept.map((c) => c.sha),
    onConflict: async (sha, files) => {
      const ans = await prompt({
        message: `cherry-pick of ${sha} conflicts in: ${files.join(", ")}\nResolve in your editor, then choose:`,
        options: ["proceed", "abort"],
        yes: false,
      });
      return ans === "proceed";
    },
  });

  const integrity = await verifyCarryIntegrity({ repoDir, carries: carry.kept, emptyPicks: branchResult.emptyPicks });
  if (integrity.length > 0) {
    console.log("carry-integrity warnings:");
    for (const f of integrity) console.log(`  [${f.kind}] ${f.sha} ${f.subject}: ${f.detail}`);
    await writeState(stateFile, {
      phase: "branch",
      ...journalBase,
      notes: integrity.map((f) => `${f.kind}:${f.sha}:${f.detail}`),
    });
    const ans = await prompt({ message: "Carry-integrity warnings above. Proceed anyway?", options: ["proceed", "abort"], yes });
    if (ans !== "proceed") return false;
  }

  await writeState(stateFile, { phase: "gates", ...journalBase });
  const gateCmds = [
    cfg.gates.install,
    cfg.gates.typecheck,
    ...(typeof cfg.gates.test === "string" ? [cfg.gates.test] : cfg.gates.test ?? []),
    cfg.gates.build,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  const gates = await runGates({ cwd: repoDir, commands: gateCmds });
  if (!gates.ok) {
    console.error(`gate failed at hop ${hopTag}: ${gates.failedCommand}\n${gates.tail}`);
    process.exit(2);
  }

  const ans1 = await prompt({ message: "Gates passed. Push branch + run cutover restart?", options: ["proceed", "abort"], yes });
  if (ans1 !== "proceed") return false;

  await writeState(stateFile, { phase: "cutover", ...journalBase });
  const cut = await runCutover({ cwd: repoDir, restartCmd: cfg.cutover.restart, verifyCmd: cfg.cutover.verify });
  if (!cut.ok) {
    console.error(`cutover verify failed:\n${cut.verifyOutput}`);
    process.exit(2);
  }

  await writeState(stateFile, { phase: "probes", ...journalBase });
  const probes: ProbeSpec[] = cfg.probes.post_cutover.map((p) => ({
    name: p.name,
    cmd: substitute(p.cmd, { tag: hopTag, fork_branch: hopBranch }),
    parse: p.parse,
    optional: p.optional,
  }));
  const probeResult = await runProbes({ cwd: repoDir, probes });
  console.log(`probes: ${probeResult.classification}`);
  for (const f of probeResult.findings) console.log(`  [${f.level}] ${f.probe}: ${f.code} — ${f.message}`);
  if (probeResult.classification === "RED") {
    const rollAns = await prompt({ message: "Probes RED. Roll back?", options: ["proceed", "abort"], yes: false });
    if (rollAns === "proceed") {
      await runRollback({
        repoDir,
        anchorTag: substitute(cfg.backup.anchor_tag, { fork_branch: substitute(cfg.fork.branch_pattern, { tag: target }), tag: target }),
        configRestores: cfg.backup.config_files.map((live) => ({ live, snapshot: `${live}.pre-${target}` })),
      });
      if (cfg.rollback.restart_after) {
        await runCutover({ cwd: repoDir, restartCmd: cfg.cutover.restart, verifyCmd: cfg.cutover.verify });
      }
    }
  }
  return true;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      "config-path": { type: "string", default: ".fork-upgrade.toml" },
      "upstream-repo": { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.tag) throw new Error("--tag is required");
  if (!values["upstream-repo"]) throw new Error("--upstream-repo is required (e.g. openclaw/openclaw)");

  const cfg = await loadConfig(values["config-path"]!);
  const repoDir = process.cwd();
  const target = values.tag!;
  const forkBranch = substitute(cfg.fork.branch_pattern, { tag: target });
  const stateFile = path.join(repoDir, ".fork-upgrade-state.json");

  await writeState(stateFile, { phase: "preflight", tag: target, forkBranch });
  const carry = await resolveCarryList({
    manifestPath: path.join(repoDir, cfg.carry.manifest),
    upstreamRepo: values["upstream-repo"]!,
    ghPrState: ghPrStateFromCli,
  });
  console.log(`carry kept: ${carry.kept.map((c) => c.sha).join(", ") || "(none)"}`);
  console.log(`carry landed-upstream (will skip): ${carry.landed.map((c) => c.sha).join(", ") || "(none)"}`);
  console.log(`carry parked (disabled): ${carry.parked.map((c) => c.sha).join(", ") || "(none)"}`);

  const shaCheck = await assertCarryShasExist({ repoDir, entries: carry.kept });
  if (!shaCheck.ok) {
    console.error("preflight: these carry SHAs do not resolve to commits:");
    for (const m of shaCheck.missing) console.error(`  ${m.sha} — ${m.subject}`);
    console.error(`Refresh the SHAs in ${cfg.carry.manifest} (git log) before running.`);
    process.exit(2);
  }

  const advisories = await searchUpstreamForCarries({
    entries: carry.kept,
    upstreamRepo: values["upstream-repo"]!,
    ghSearch: ghSearchFromCli,
  });
  for (const a of advisories) {
    console.log(
      `advisory: carry ${a.entry.sha} "${a.entry.subject}" may have landed upstream — ` +
        `${a.hits.length} match(es): ${a.hits.map((h) => h.url).join(", ")}`,
    );
  }

  const ladder = [target];
  console.log(`tag ladder: ${ladder.join(" -> ")}`);

  if (values["dry-run"]) return;

  await writeState(stateFile, { phase: "backup", tag: target, forkBranch });
  await runBackup({
    repoDir,
    anchorTag: substitute(cfg.backup.anchor_tag, { fork_branch: forkBranch, tag: target }),
    pushAnchor: cfg.backup.push_anchor,
    originRemote: cfg.fork.origin_remote,
    configFiles: cfg.backup.config_files,
    configSnapshotSuffix: `.pre-${target}`,
    stateArchive: cfg.backup.state_archive
      ? { paths: cfg.backup.state_archive.paths, output: substitute(cfg.backup.state_archive.output, { tag: target }) }
      : undefined,
  });

  const ctx: HopCtx = { repoDir, cfg, carry, stateFile, yes: values.yes, target, ladder };
  for (let i = 0; i < ladder.length; i++) {
    const proceed = await runHop(ctx, ladder[i], i);
    if (!proceed) return;
  }

  await writeState(stateFile, { phase: "done", tag: target, forkBranch });
}
```

(The imports at the top of the file and the `main().catch(...)` trailer are unchanged.)

- [ ] **Step 2: Build and run the full suite**

Run: `npm run build && npm test`
Expected: PASS — all existing integration tests (happy-path, rollback, parked-carry, sha-guard, carry-integrity) green and unchanged in behavior; the only new stdout line is `tag ladder: v2` (single hop), which no existing test asserts against negatively.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor(cli): extract runHop and walk a single-hop ladder (no behavior change) (#1)"
```

---

## Task 6: Enumerate the ladder + flags + intermediate/final hop behavior

**Files:**
- Modify: `src/index.ts`
- Test: `tests/integration/ladder.test.ts` (create)

**Interfaces:**
- Consumes: `resolveLadder` (Task 2), the `runHop`/`HopCtx`/single-hop loop (Task 5).
- Produces: `runHop` gains a `final: boolean` parameter; `main` resolves a real ladder and adds `--from-tag`, `--single-tag`, `--ladder-stop-at` flags.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/ladder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";

const CONFIG = `
[upstream]
remote = "upstream"
[fork]
origin_remote = "origin"
branch_pattern = "fork/{tag}"
[carry]
manifest = ".fork-upgrade-carry.toml"
[backup]
anchor_tag = "pre-migration/{fork_branch}"
push_anchor = false
config_files = []
[gates]
build = "true"
[cutover]
restart = "true"
verify = "true"
[probes]
post_cutover = [{ name = "ok", cmd = "true", parse = "exit" }]
[rollback]
restart_after = false
`;

// Build an upstream with v1,v2,v2.1-rc,v3 and a fork on v1 with one carry commit.
async function buildLadderRepo(): Promise<{ fork: string; carrySha: string }> {
  const root = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "m2-ladder-"));
  const upstream = path.join(root, "upstream");
  const fork = path.join(root, "fork");
  await fs.mkdir(upstream);
  await execa("git", ["init", "-b", "main"], { cwd: upstream });
  await execa("git", ["config", "user.email", "u@e.com"], { cwd: upstream });
  await execa("git", ["config", "user.name", "u"], { cwd: upstream });
  for (const v of ["v1", "v2", "v2.1-rc", "v3"]) {
    await fs.writeFile(path.join(upstream, "main.txt"), v, "utf-8");
    await execa("git", ["add", "."], { cwd: upstream });
    await execa("git", ["commit", "-m", v], { cwd: upstream });
    await execa("git", ["tag", v], { cwd: upstream });
  }
  await execa("git", ["clone", upstream, fork]);
  await execa("git", ["config", "user.email", "f@e.com"], { cwd: fork });
  await execa("git", ["config", "user.name", "f"], { cwd: fork });
  await execa("git", ["remote", "add", "upstream", upstream], { cwd: fork });
  await execa("git", ["fetch", "upstream", "--tags"], { cwd: fork });
  await execa("git", ["checkout", "-b", "fork/v1", "v1"], { cwd: fork });
  await fs.writeFile(path.join(fork, "carry.txt"), "carry", "utf-8");
  await execa("git", ["add", "."], { cwd: fork });
  await execa("git", ["commit", "-m", "fork carry"], { cwd: fork });
  const { stdout: carrySha } = await execa("git", ["rev-parse", "HEAD"], { cwd: fork });
  return { fork, carrySha: carrySha.trim() };
}

describe("multi-tag ladder", () => {
  it("walks intermediate stable tags, excludes pre-releases, cuts over only on the final hop", async () => {
    const { fork, carrySha } = await buildLadderRepo();
    await fs.writeFile(path.join(fork, ".fork-upgrade.toml"), CONFIG, "utf-8");
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-carry.toml"),
      `\n[[commits]]\nsha = "${carrySha}"\nsubject = "fork carry"\n`,
      "utf-8",
    );
    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [distEntry, "--tag", "v3", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("tag ladder: v2 -> v3"); // rc excluded
    expect(stdout).not.toContain("v2.1-rc");
    // cutover/probes only once (final hop v3)
    expect(stdout.match(/probes: GREEN/g)?.length).toBe(1);
    // final branch exists; intermediate branch was deleted
    const { stdout: v3 } = await execa("git", ["branch", "--list", "fork/v3"], { cwd: fork });
    const { stdout: v2 } = await execa("git", ["branch", "--list", "fork/v2"], { cwd: fork });
    expect(v3).toContain("fork/v3");
    expect(v2.trim()).toBe("");
  });

  it("--single-tag skips enumeration and jumps straight to the target", async () => {
    const { fork, carrySha } = await buildLadderRepo();
    await fs.writeFile(path.join(fork, ".fork-upgrade.toml"), CONFIG, "utf-8");
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-carry.toml"),
      `\n[[commits]]\nsha = "${carrySha}"\nsubject = "fork carry"\n`,
      "utf-8",
    );
    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [distEntry, "--tag", "v3", "--upstream-repo", "fixture/repo", "--single-tag", "--yes"],
      { cwd: fork, reject: false },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("tag ladder: v3");
    expect(stdout).not.toContain("v2 -> v3");
  });
});
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build && npm test -- integration/ladder`
Expected: FAIL — the ladder is still hardcoded to `[target]`, so output shows `tag ladder: v3` (not `v2 -> v3`) and the first test's ladder/branch assertions fail.

- [ ] **Step 3: Add the `final` parameter to `runHop` and the intermediate-hop path**

In `src/index.ts`, change the `runHop` signature and add the intermediate branch handling. Update the signature line:

```ts
async function runHop(ctx: HopCtx, hopTag: string, ladderIndex: number, final: boolean): Promise<boolean> {
```

Change the integrity-findings block so only the FINAL hop prompts (intermediate hops warn and continue). Replace:

```ts
    const ans = await prompt({ message: "Carry-integrity warnings above. Proceed anyway?", options: ["proceed", "abort"], yes });
    if (ans !== "proceed") return false;
```

with:

```ts
    if (final) {
      const ans = await prompt({ message: "Carry-integrity warnings above. Proceed anyway?", options: ["proceed", "abort"], yes });
      if (ans !== "proceed") return false;
    }
```

Immediately AFTER the gate-failure `process.exit(2)` block (i.e. after gates have passed) and BEFORE the `const ans1 = await prompt({ message: "Gates passed...` line, insert the intermediate short-circuit:

```ts
  if (!final) {
    // Intermediate validation hop passed: discard the throwaway branch and move on.
    // Detach to the upstream tag first so the branch we're on can be deleted.
    await execa("git", ["checkout", hopTag], { cwd: repoDir });
    await execa("git", ["branch", "-D", hopBranch], { cwd: repoDir });
    return true;
  }
```

Add `import { execa } from "execa";` to the top of `src/index.ts` (it is not yet imported there).

- [ ] **Step 4: Wire flags + real ladder enumeration in `main`**

Add the three flags to the `parseArgs` options object:

```ts
      "from-tag": { type: "string" },
      "single-tag": { type: "boolean", default: false },
      "ladder-stop-at": { type: "string" },
```

Add the `resolveLadder` import to the `./ladder.js` (new import line near the other imports):

```ts
import { resolveLadder } from "./ladder.js";
```

Replace the placeholder ladder block:

```ts
  const ladder = [target];
  console.log(`tag ladder: ${ladder.join(" -> ")}`);
```

with:

```ts
  let ladder: string[];
  if (values["single-tag"]) {
    ladder = [target];
  } else {
    const resolved = await resolveLadder({
      repoDir,
      tagPattern: cfg.upstream.tag_pattern,
      prereleasePattern: cfg.upstream.prerelease_pattern,
      fromTag: values["from-tag"],
      target,
    });
    ladder = resolved.ladder;
  }
  if (values["ladder-stop-at"]) {
    const stop = ladder.indexOf(values["ladder-stop-at"]);
    if (stop === -1) throw new Error(`--ladder-stop-at '${values["ladder-stop-at"]}' is not in the ladder: ${ladder.join(", ")}`);
    ladder = ladder.slice(0, stop + 1);
  }
  console.log(`tag ladder: ${ladder.join(" -> ")}`);
```

Update the hop loop to pass `final`:

```ts
  const ctx: HopCtx = { repoDir, cfg, carry, stateFile, yes: values.yes, target, ladder };
  for (let i = 0; i < ladder.length; i++) {
    const proceed = await runHop(ctx, ladder[i], i, i === ladder.length - 1);
    if (!proceed) return;
  }
```

- [ ] **Step 5: Build and run to verify it passes**

Run: `npm run build && npm test`
Expected: PASS — both new ladder integration tests green; all existing tests green (the M1 fixtures use adjacent `v1`→`v2`, so the ladder is `[v2]`, a single final hop — unchanged behavior).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/integration/ladder.test.ts
git commit -m "feat(cli): walk the tag ladder with intermediate validation hops + flags (#1)"
```

---

## Task 7: `--resume`

**Files:**
- Modify: `src/index.ts`
- Test: `tests/integration/resume.test.ts` (create)

**Interfaces:**
- Consumes: `readState` (from `./state.js`), `branchAndCherryPick` `force` flag (Task 3), the `runHop` loop (Task 6).
- Produces: a `--resume` flag that re-enters the hop walk from the journaled `ladderIndex`/`phase`, refusing on a divergent working tree.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/resume.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";

const CONFIG = `
[upstream]
remote = "upstream"
[fork]
origin_remote = "origin"
branch_pattern = "fork/{tag}"
[carry]
manifest = ".fork-upgrade-carry.toml"
[backup]
anchor_tag = "pre-migration/{fork_branch}"
push_anchor = false
config_files = []
[gates]
build = "true"
[cutover]
restart = "true"
verify = "true"
[probes]
post_cutover = [{ name = "ok", cmd = "true", parse = "exit" }]
[rollback]
restart_after = false
`;

async function buildForkOnV1(): Promise<{ fork: string; carrySha: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m2-resume-"));
  const upstream = path.join(root, "upstream");
  const fork = path.join(root, "fork");
  await fs.mkdir(upstream);
  await execa("git", ["init", "-b", "main"], { cwd: upstream });
  await execa("git", ["config", "user.email", "u@e.com"], { cwd: upstream });
  await execa("git", ["config", "user.name", "u"], { cwd: upstream });
  for (const v of ["v1", "v2"]) {
    await fs.writeFile(path.join(upstream, "main.txt"), v, "utf-8");
    await execa("git", ["add", "."], { cwd: upstream });
    await execa("git", ["commit", "-m", v], { cwd: upstream });
    await execa("git", ["tag", v], { cwd: upstream });
  }
  await execa("git", ["clone", upstream, fork]);
  await execa("git", ["config", "user.email", "f@e.com"], { cwd: fork });
  await execa("git", ["config", "user.name", "f"], { cwd: fork });
  await execa("git", ["checkout", "-b", "fork/v2", "v2"], { cwd: fork }); // already on the hop branch
  await fs.writeFile(path.join(fork, "carry.txt"), "carry", "utf-8");
  await execa("git", ["add", "."], { cwd: fork });
  await execa("git", ["commit", "-m", "carry"], { cwd: fork });
  const { stdout: carrySha } = await execa("git", ["rev-parse", "HEAD"], { cwd: fork });
  return { fork, carrySha: carrySha.trim() };
}

describe("--resume", () => {
  it("resumes from the journaled hop and completes", async () => {
    const { fork, carrySha } = await buildForkOnV1();
    await fs.writeFile(path.join(fork, ".fork-upgrade.toml"), CONFIG, "utf-8");
    await fs.writeFile(path.join(fork, ".fork-upgrade-carry.toml"), `\n[[commits]]\nsha = "${carrySha}"\nsubject = "c"\n`, "utf-8");
    // journal pinned mid-run at the (only/final) hop, phase gates, HEAD already on fork/v2
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-state.json"),
      JSON.stringify({ phase: "gates", tag: "v2", forkBranch: "fork/v2", startedAt: 1, ladder: ["v2"], ladderIndex: 0, hopTag: "v2" }),
      "utf-8",
    );
    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [distEntry, "--resume", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("resuming from hop v2");
    expect(stdout).toContain("probes: GREEN");
  });

  it("refuses to resume when HEAD is not on the journaled hop branch", async () => {
    const { fork, carrySha } = await buildForkOnV1();
    await fs.writeFile(path.join(fork, ".fork-upgrade.toml"), CONFIG, "utf-8");
    await fs.writeFile(path.join(fork, ".fork-upgrade-carry.toml"), `\n[[commits]]\nsha = "${carrySha}"\nsubject = "c"\n`, "utf-8");
    await execa("git", ["checkout", "-b", "somewhere-else"], { cwd: fork });
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-state.json"),
      JSON.stringify({ phase: "gates", tag: "v2", forkBranch: "fork/v2", startedAt: 1, ladder: ["v2"], ladderIndex: 0, hopTag: "v2" }),
      "utf-8",
    );
    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stderr } = await execa(
      "node",
      [distEntry, "--resume", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("refusing to resume");
  });
});
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build && npm test -- integration/resume`
Expected: FAIL — `--resume` is not a recognized flag (parseArgs ignores unknown? No — `parseArgs` throws on unknown options by default), so the run errors / does not produce the resume output.

- [ ] **Step 3: Add the `--resume` flag and the resume branch in `main`**

Add to the `parseArgs` options:

```ts
      resume: { type: "boolean", default: false },
```

Add the `readState` import (extend the existing `./state.js` import):

```ts
import { writeState, readState } from "./state.js";
```

Add `execa` usage for the divergence check (already imported in Task 6). Insert a resume block at the very start of `main`, right after `const stateFile = ...` is computed but you need `cfg`/`repoDir` first — so place it immediately after `const stateFile = path.join(repoDir, ".fork-upgrade-state.json");`:

```ts
  if (values.resume) {
    const prior = await readState(stateFile);
    if (!prior) {
      console.error(`--resume: no journal found at ${stateFile}`);
      process.exit(2);
    }
    const resumeTarget = prior.tag;
    const resumeLadder = prior.ladder ?? [resumeTarget];
    const resumeIndex = prior.ladderIndex ?? 0;
    const resumeHopTag = prior.hopTag ?? resumeTarget;
    const expectedBranch = substitute(cfg.fork.branch_pattern, { tag: resumeHopTag });
    // Divergence refusal: dirty tree or HEAD not on the journaled hop branch.
    const { stdout: dirty } = await execa("git", ["status", "--porcelain"], { cwd: repoDir });
    const { stdout: head } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir });
    if (dirty.trim() !== "") {
      console.error("refusing to resume: working tree has uncommitted changes");
      process.exit(2);
    }
    if (head.trim() !== expectedBranch) {
      console.error(`refusing to resume: HEAD is on '${head.trim()}', expected the journaled hop branch '${expectedBranch}'`);
      process.exit(2);
    }
    const carry = await resolveCarryList({
      manifestPath: path.join(repoDir, cfg.carry.manifest),
      upstreamRepo: values["upstream-repo"]!,
      ghPrState: ghPrStateFromCli,
    });
    console.log(`resuming from hop ${resumeHopTag} (phase ${prior.phase}, ladder ${resumeLadder.join(" -> ")})`);
    const ctx: HopCtx = { repoDir, cfg, carry, stateFile, yes: values.yes, target: resumeTarget, ladder: resumeLadder, resume: true };
    for (let i = resumeIndex; i < resumeLadder.length; i++) {
      const proceed = await runHop(ctx, resumeLadder[i], i, i === resumeLadder.length - 1);
      if (!proceed) return;
    }
    await writeState(stateFile, { phase: "done", tag: resumeTarget, forkBranch: expectedBranch });
    return;
  }
```

- [ ] **Step 4: Thread `resume` through `HopCtx` and force-recreate the branch on resume**

Add `resume?: boolean` to `HopCtx`:

```ts
type HopCtx = {
  repoDir: string;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  carry: Awaited<ReturnType<typeof resolveCarryList>>;
  stateFile: string;
  yes: boolean;
  target: string;
  ladder: string[];
  resume?: boolean;
};
```

In `runHop`, pass `force` to `branchAndCherryPick` so a resumed hop force-recreates its half-built branch. Change the `branchAndCherryPick({ ... })` call to include:

```ts
    force: ctx.resume === true,
```

(Add the `force` line alongside `repoDir`/`newBranch`/`baseRef`/`shas`/`onConflict`. Destructure `resume` is not needed — reference `ctx.resume` directly, since the existing destructure `const { repoDir, cfg, carry, stateFile, yes, target, ladder } = ctx;` does not include it.)

- [ ] **Step 5: Build and run to verify it passes**

Run: `npm run build && npm test`
Expected: PASS — both resume integration tests green (resume completes; divergent HEAD refused); all prior tests green.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/integration/resume.test.ts
git commit -m "feat(cli): --resume re-enters the journaled hop; refuses on divergence (#2)"
```

---

## Final verification (end of M2)

- [ ] `npm run build` — clean (tsc).
- [ ] `npm test` — full suite green, output pristine.
- [ ] Update `README.md`: document multi-tag laddering (automatic; `--single-tag`, `--from-tag`, `--ladder-stop-at`), the `[upstream].prerelease_pattern` config, and `--resume`; remove the "Single-tag jumps only" and "`--resume` … planned" lines from the Limitations section (they become untrue). Fold this into the PR.

## Self-review notes (addressed)

- **Spec coverage:** Unit A (#1 resolution) → Tasks 1–2; Unit B (#1 orchestration) → Tasks 5–6; Unit C (#2 resume) → Tasks 3 (force flag), 4 (state fields), 7 (resume). Config `prerelease_pattern` → Task 2. README → Final verification.
- **Type consistency:** `LadderResolution`/`filterAndOrderTags`/`resolveLadder` names match across Tasks 1–2 and their use in Task 6. `HopCtx` is introduced in Task 5 and extended (`resume?`) in Task 7; `runHop` gains `final` in Task 6 and is called with it everywhere thereafter (the resume loop in Task 7 passes it too). `branchAndCherryPick` `force` (Task 3) is consumed in Task 7. State fields (Task 4) are written by `runHop` from Task 5 onward and read in Task 7.
- **Ordering:** State fields (Task 4) precede the orchestration that writes them (Tasks 5–7); the `force` flag (Task 3) precedes its use (Task 7).
- **No placeholders:** every code/test step contains complete, runnable content.
