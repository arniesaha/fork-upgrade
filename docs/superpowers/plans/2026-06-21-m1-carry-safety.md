# M1 — Carry Safety & Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the carry set provably correct — guard SHAs before mutation, support parked/pinned carries, surface upstream-search advisories, and detect silently-dropped or absorbed carries before cutover.

**Architecture:** Four independent units over the carry manifest. Units A–C extend `src/carry-manifest.ts` (pure functions with injectable `gh`/git access) and wire into `src/index.ts` preflight. Unit D adds an empty-commit return to `src/branch.ts` and a new `src/carry-integrity.ts`, wired into a post-branch checkpoint. All schema additions are additive and backward-compatible; existing manifests parse unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥ 18, `@iarna/toml`, `zod`, `execa`, vitest. Tests build real temp git repos.

## Global Constraints

- **Backward-compatible schema:** every new manifest field is `z.…optional().default(…)`; existing two-field manifests must parse and behave exactly as before.
- **`gh`-backed calls degrade gracefully:** `ghPrStateFromCli` and the new `ghSearchFromCli` swallow all failures (missing/offline/unauth `gh`) and return "no information"; they never abort a run.
- **Search never auto-skips:** `upstream_search` is advisory only; only a *merged* `upstream_pr` (or `pin`) changes which carries are kept.
- **Rollback prompt stays the only never-auto-confirmed gate.** The new integrity checkpoint respects `--yes` (proceeds) but always prints findings.
- **No repo mutation before the Unit A guard passes.**
- **Per PR:** `npm run build` clean and the full vitest suite green before opening the PR.
- Delivery: four PRs, one per unit, in order A → B → C → D, each branched off `main` (current working branch `feat/m1-carry-safety` holds the spec/plan; cut per-unit branches from it or from `main` as preferred).

---

## PR 1 — Unit A: Preflight SHA existence guard (#13)

### Task 1: `assertCarryShasExist`

**Files:**
- Modify: `src/carry-manifest.ts` (append new exported function)
- Test: `tests/unit/carry-sha-guard.test.ts` (create)

**Interfaces:**
- Consumes: `CarryEntry` (existing export), `execa`.
- Produces: `assertCarryShasExist(params: { repoDir: string; entries: CarryEntry[] }): Promise<{ ok: boolean; missing: CarryEntry[] }>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/carry-sha-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";
import { assertCarryShasExist } from "../../src/carry-manifest.js";

async function tmpRepoWithOneCommit(): Promise<{ repo: string; sha: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sha-guard-"));
  await execa("git", ["init", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.email", "t@e.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "t"], { cwd: repo });
  await fs.writeFile(path.join(repo, "f.txt"), "x", "utf-8");
  await execa("git", ["add", "."], { cwd: repo });
  await execa("git", ["commit", "-m", "c1"], { cwd: repo });
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });
  return { repo, sha: stdout.trim() };
}

describe("assertCarryShasExist", () => {
  it("flags carries whose SHA does not resolve to a commit", async () => {
    const { repo, sha } = await tmpRepoWithOneCommit();
    const entries = [
      { sha, subject: "real", upstream_pr: "", upstream_search: "" },
      { sha: "REFRESH-01", subject: "placeholder", upstream_pr: "", upstream_search: "" },
    ];
    const result = await assertCarryShasExist({ repoDir: repo, entries });
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.sha)).toEqual(["REFRESH-01"]);
  });

  it("returns ok when every SHA resolves", async () => {
    const { repo, sha } = await tmpRepoWithOneCommit();
    const result = await assertCarryShasExist({
      repoDir: repo,
      entries: [{ sha, subject: "real", upstream_pr: "", upstream_search: "" }],
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
```

> Note: entry literals here carry only the four fields that exist in PR 1. `assertCarryShasExist` reads only `entry.sha`, so later schema additions (PR 2/4) do not affect this test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- carry-sha-guard`
Expected: FAIL — `assertCarryShasExist` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/carry-manifest.ts`:

```ts
export async function assertCarryShasExist(params: {
  repoDir: string;
  entries: CarryEntry[];
}): Promise<{ ok: boolean; missing: CarryEntry[] }> {
  const missing: CarryEntry[] = [];
  for (const entry of params.entries) {
    try {
      await execa(
        "git",
        ["rev-parse", "--verify", "--quiet", `${entry.sha}^{commit}`],
        { cwd: params.repoDir },
      );
    } catch {
      missing.push(entry);
    }
  }
  return { ok: missing.length === 0, missing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- carry-sha-guard`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/carry-manifest.ts tests/unit/carry-sha-guard.test.ts
git commit -m "feat(carry): assertCarryShasExist preflight guard (#13)"
```

### Task 2: Wire the guard into preflight + integration test

**Files:**
- Modify: `src/index.ts` (after `resolveCarryList`, before the `--dry-run` return)
- Test: `tests/integration/sha-guard.test.ts` (create)

**Interfaces:**
- Consumes: `assertCarryShasExist` (Task 1), `resolveCarryList` (existing).

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/sha-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { buildFixtureUpstreamAndFork } from "../fixtures/build-fixture-repos.js";

describe("preflight SHA guard", () => {
  it("aborts before mutating the repo when a carry SHA does not resolve", async () => {
    const { fork } = await buildFixtureUpstreamAndFork();
    await fs.writeFile(
      path.join(fork, ".fork-upgrade.toml"),
      `
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
      `,
      "utf-8",
    );
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-carry.toml"),
      `
[[commits]]
sha = "REFRESH-01"
subject = "placeholder carry"
      `,
      "utf-8",
    );

    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stderr } = await execa(
      "node",
      [distEntry, "--tag", "v2", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );

    expect(exitCode).toBe(2);
    expect(stderr).toContain("REFRESH-01");
    // No branch was created — guard ran before the branch phase.
    const { stdout: branches } = await execa("git", ["branch", "--list", "fork/v2"], { cwd: fork });
    expect(branches.trim()).toBe("");
  });
});
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build && npm test -- sha-guard`
Expected: FAIL — the run currently proceeds past preflight (no guard); exit code is not 2 and/or branch `fork/v2` is created.

- [ ] **Step 3: Wire the guard into `src/index.ts`**

In `src/index.ts`, locate:

```ts
  console.log(`carry kept: ${carry.kept.map((c) => c.sha).join(", ") || "(none)"}`);
  console.log(`carry landed-upstream (will skip): ${carry.landed.map((c) => c.sha).join(", ") || "(none)"}`);

  if (values["dry-run"]) return;
```

Insert the guard between the `console.log`s and the `--dry-run` return, and add `assertCarryShasExist` to the import from `./carry-manifest.js`:

```ts
  console.log(`carry kept: ${carry.kept.map((c) => c.sha).join(", ") || "(none)"}`);
  console.log(`carry landed-upstream (will skip): ${carry.landed.map((c) => c.sha).join(", ") || "(none)"}`);

  const shaCheck = await assertCarryShasExist({ repoDir, entries: carry.kept });
  if (!shaCheck.ok) {
    console.error("preflight: these carry SHAs do not resolve to commits:");
    for (const m of shaCheck.missing) console.error(`  ${m.sha} — ${m.subject}`);
    console.error(`Refresh the SHAs in ${cfg.carry.manifest} (git log) before running.`);
    process.exit(2);
  }

  if (values["dry-run"]) return;
```

Update the import line:

```ts
import { resolveCarryList, ghPrStateFromCli, assertCarryShasExist } from "./carry-manifest.js";
```

- [ ] **Step 4: Build and run to verify it passes**

Run: `npm run build && npm test`
Expected: PASS — `sha-guard` integration test green; existing happy-path/rollback still green (they use real SHAs).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/integration/sha-guard.test.ts
git commit -m "feat(cli): fail fast on unresolved carry SHAs before any mutation (#13)"
```

---

## PR 2 — Unit B: `enabled` + `pin` carry fields (#7)

### Task 3: Schema fields + `parked` resolution

**Files:**
- Modify: `src/carry-manifest.ts` (`CarryEntrySchema`, `ResolvedCarryList`, `resolveCarryList`)
- Test: `tests/unit/carry-manifest.test.ts` (add cases)

**Interfaces:**
- Produces: `CarryEntry` gains `enabled: boolean`, `pin: boolean`. `ResolvedCarryList` gains `parked: CarryEntry[]`. `resolveCarryList(...)` now returns `{ kept, landed, parked }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/carry-manifest.test.ts` (inside the existing `describe`):

```ts
  it("parks a disabled carry instead of keeping or landing it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-parked-"));
    await fs.writeFile(
      path.join(root, ".fork-upgrade-carry.toml"),
      `
[[commits]]
sha = "aaa111"
subject = "active"

[[commits]]
sha = "bbb222"
subject = "parked"
enabled = false
      `,
      "utf-8",
    );
    const ghPrState = vi.fn(async () => "unknown" as const);
    const result = await resolveCarryList({
      manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
      upstreamRepo: "openclaw/openclaw",
      ghPrState,
    });
    expect(result.kept.map((c) => c.sha)).toEqual(["aaa111"]);
    expect(result.parked.map((c) => c.sha)).toEqual(["bbb222"]);
    expect(result.landed).toEqual([]);
  });

  it("keeps a pinned carry even when its upstream_pr is merged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-pinned-"));
    await fs.writeFile(
      path.join(root, ".fork-upgrade-carry.toml"),
      `
[[commits]]
sha = "ccc333"
subject = "pinned load-bearing"
upstream_pr = "95608"
pin = true
      `,
      "utf-8",
    );
    const ghPrState = vi.fn(async () => "merged" as const);
    const result = await resolveCarryList({
      manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
      upstreamRepo: "openclaw/openclaw",
      ghPrState,
    });
    expect(result.kept.map((c) => c.sha)).toEqual(["ccc333"]);
    expect(result.landed).toEqual([]);
    // pinned carry never triggers a PR-state lookup
    expect(ghPrState).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- carry-manifest`
Expected: FAIL — `result.parked` is undefined; pinned carry is checked/landed.

- [ ] **Step 3: Implement schema + resolution**

In `src/carry-manifest.ts`, extend `CarryEntrySchema`:

```ts
const CarryEntrySchema = z.object({
  sha: z.string(),
  subject: z.string(),
  upstream_pr: z.string().optional().default(""),
  upstream_search: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
  pin: z.boolean().optional().default(false),
});
```

Extend `ResolvedCarryList`:

```ts
export type ResolvedCarryList = {
  kept: CarryEntry[];
  landed: CarryEntry[];
  parked: CarryEntry[];
};
```

Rewrite the loop in `resolveCarryList`:

```ts
  const kept: CarryEntry[] = [];
  const landed: CarryEntry[] = [];
  const parked: CarryEntry[] = [];
  for (const entry of parsed.commits) {
    if (!entry.enabled) {
      parked.push(entry);
      continue;
    }
    if (entry.pin) {
      kept.push(entry);
      continue;
    }
    if (entry.upstream_pr) {
      const state = await params.ghPrState(entry.upstream_pr, params.upstreamRepo);
      if (state === "merged") {
        landed.push(entry);
        continue;
      }
    }
    kept.push(entry);
  }
  return { kept, landed, parked };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- carry-manifest`
Expected: PASS (existing merged-PR test + two new tests).

- [ ] **Step 5: Commit**

```bash
git add src/carry-manifest.ts tests/unit/carry-manifest.test.ts
git commit -m "feat(carry): enabled (park) and pin (never-skip) fields (#7)"
```

### Task 4: Print parked carries + update OpenClaw example + integration

**Files:**
- Modify: `src/index.ts` (preflight print)
- Modify: `examples/openclaw/.fork-upgrade-carry.toml` (carry 12 → pin + restored PR)
- Test: `tests/integration/parked-carry.test.ts` (create)

**Interfaces:**
- Consumes: `resolveCarryList` returning `parked` (Task 3).

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/parked-carry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { buildFixtureUpstreamAndFork } from "../fixtures/build-fixture-repos.js";

describe("parked carry", () => {
  it("does not cherry-pick a disabled carry but still completes GREEN", async () => {
    const { fork } = await buildFixtureUpstreamAndFork();
    const { stdout: forkSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: fork });
    await fs.writeFile(
      path.join(fork, ".fork-upgrade.toml"),
      `
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
      `,
      "utf-8",
    );
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-carry.toml"),
      `
[[commits]]
sha = "${forkSha.trim()}"
subject = "fork carry"
enabled = false
      `,
      "utf-8",
    );

    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [distEntry, "--tag", "v2", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );

    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("carry parked (disabled)");
    expect(stdout).toContain("probes: GREEN");
    // carry.txt was NOT applied to the new branch (carry is parked)
    const exists = await fs
      .stat(path.join(fork, "carry.txt"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build && npm test -- parked-carry`
Expected: FAIL — `stdout` lacks "carry parked (disabled)" (not printed yet).

- [ ] **Step 3: Print parked carries in `src/index.ts`**

After the `carry landed-upstream` console.log, add:

```ts
  console.log(`carry parked (disabled): ${carry.parked.map((c) => c.sha).join(", ") || "(none)"}`);
```

- [ ] **Step 4: Build and run to verify it passes**

Run: `npm run build && npm test -- parked-carry`
Expected: PASS.

- [ ] **Step 5: Update the OpenClaw example carry 12**

In `examples/openclaw/.fork-upgrade-carry.toml`, replace the carry-12 comment block and entry with:

```toml
# Carry 12 is a parked WIP commit that is NOT yet PR'd on its own, but IS
# load-bearing: the live dist/ was built with it, so it must be carried. It is
# conceptually part of #95608 but is NOT itself contained in that PR.
#
# It is `pin = true` so it is carried UNCONDITIONALLY and never auto-skipped,
# even though `upstream_pr` is set for traceability. Without the pin, this commit
# would be dropped the moment #95608 merges -- silently losing a deployed change.
[[commits]]
sha = "REFRESH-12"
subject = "wip(diagnostics): clientContext stale-clear + onTrustedDiagnosticEvent wiring"
upstream_pr = "95608"
upstream_search = "clientContext stale-clear onTrustedDiagnosticEvent wiring"
pin = true
```

- [ ] **Step 6: Commit**

```bash
git add src/index.ts examples/openclaw/.fork-upgrade-carry.toml tests/integration/parked-carry.test.ts
git commit -m "feat(cli): surface parked carries; pin load-bearing example carry 12 (#7)"
```

---

## PR 3 — Unit C: `upstream_search` advisory query (#3)

### Task 5: `searchUpstreamForCarries` + `ghSearchFromCli`

**Files:**
- Modify: `src/carry-manifest.ts` (new types + functions)
- Test: `tests/unit/carry-search.test.ts` (create)

**Interfaces:**
- Produces:
  - `type GhSearchHit = { sha: string; url: string; subject: string }`
  - `type GhSearchFn = (query: string, upstreamRepo: string) => Promise<GhSearchHit[]>`
  - `searchUpstreamForCarries(params: { entries: CarryEntry[]; upstreamRepo: string; ghSearch: GhSearchFn }): Promise<Array<{ entry: CarryEntry; hits: GhSearchHit[] }>>`
  - `ghSearchFromCli: GhSearchFn`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/carry-search.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { resolveCarryList, searchUpstreamForCarries } from "../../src/carry-manifest.js";

async function keptFrom(tomlBody: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-search-"));
  await fs.writeFile(path.join(root, ".fork-upgrade-carry.toml"), tomlBody, "utf-8");
  const resolved = await resolveCarryList({
    manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
    upstreamRepo: "openclaw/openclaw",
    ghPrState: async () => "unknown",
  });
  return resolved.kept;
}

describe("searchUpstreamForCarries", () => {
  it("returns an advisory for a carry whose search query matches upstream", async () => {
    const kept = await keptFrom(`
[[commits]]
sha = "aaa111"
subject = "needs search"
upstream_search = "clientContext mapper"
`);
    const ghSearch = vi.fn(async () => [
      { sha: "deadbeef", url: "https://github.com/o/r/commit/deadbeef", subject: "add clientContext mapper" },
    ]);
    const advisories = await searchUpstreamForCarries({
      entries: kept,
      upstreamRepo: "openclaw/openclaw",
      ghSearch,
    });
    expect(advisories).toHaveLength(1);
    expect(advisories[0].entry.sha).toBe("aaa111");
    expect(advisories[0].hits[0].sha).toBe("deadbeef");
    expect(ghSearch).toHaveBeenCalledWith("clientContext mapper", "openclaw/openclaw");
  });

  it("skips carries with no upstream_search and never throws on search hits", async () => {
    const kept = await keptFrom(`
[[commits]]
sha = "bbb222"
subject = "no search field"
`);
    const ghSearch = vi.fn(async () => [
      { sha: "x", url: "u", subject: "s" },
    ]);
    const advisories = await searchUpstreamForCarries({
      entries: kept,
      upstreamRepo: "openclaw/openclaw",
      ghSearch,
    });
    expect(advisories).toEqual([]);
    expect(ghSearch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- carry-search`
Expected: FAIL — `searchUpstreamForCarries` not exported.

- [ ] **Step 3: Implement**

Append to `src/carry-manifest.ts`:

```ts
export type GhSearchHit = { sha: string; url: string; subject: string };
export type GhSearchFn = (query: string, upstreamRepo: string) => Promise<GhSearchHit[]>;

export async function searchUpstreamForCarries(params: {
  entries: CarryEntry[];
  upstreamRepo: string;
  ghSearch: GhSearchFn;
}): Promise<Array<{ entry: CarryEntry; hits: GhSearchHit[] }>> {
  const advisories: Array<{ entry: CarryEntry; hits: GhSearchHit[] }> = [];
  for (const entry of params.entries) {
    if (!entry.upstream_search) continue;
    const hits = await params.ghSearch(entry.upstream_search, params.upstreamRepo);
    if (hits.length > 0) advisories.push({ entry, hits });
  }
  return advisories;
}

export const ghSearchFromCli: GhSearchFn = async (query, upstreamRepo) => {
  try {
    const { stdout } = await execa("gh", [
      "search",
      "commits",
      query,
      "--repo",
      upstreamRepo,
      "--limit",
      "3",
      "--json",
      "sha,url,commit",
    ]);
    const rows = JSON.parse(stdout) as Array<{
      sha?: string;
      url?: string;
      commit?: { message?: string };
    }>;
    return rows.map((r) => ({
      sha: r.sha ?? "",
      url: r.url ?? "",
      subject: (r.commit?.message ?? "").split("\n")[0],
    }));
  } catch {
    return [];
  }
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- carry-search`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/carry-manifest.ts tests/unit/carry-search.test.ts
git commit -m "feat(carry): upstream_search advisory query (#3)"
```

### Task 6: Wire advisories into preflight

**Files:**
- Modify: `src/index.ts` (import + advisory print before `--dry-run` return)

**Interfaces:**
- Consumes: `searchUpstreamForCarries`, `ghSearchFromCli` (Task 5).

- [ ] **Step 1: Update the import in `src/index.ts`**

```ts
import {
  resolveCarryList,
  ghPrStateFromCli,
  assertCarryShasExist,
  searchUpstreamForCarries,
  ghSearchFromCli,
} from "./carry-manifest.js";
```

- [ ] **Step 2: Add the advisory print**

Immediately after the SHA-guard block (and before `if (values["dry-run"]) return;`), add:

```ts
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
```

- [ ] **Step 3: Build and run the full suite**

Run: `npm run build && npm test`
Expected: PASS — all existing/new tests green. (The fixture manifests set no `upstream_search`, so `ghSearchFromCli` is never invoked during integration runs.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): print upstream_search advisories in preflight (#3)"
```

---

## PR 4 — Unit D: Carry-integrity verification (#9)

### Task 7: Empty-commit net in `branchAndCherryPick`

**Files:**
- Modify: `src/branch.ts` (return `{ emptyPicks }`, skip absorbed picks)
- Test: `tests/unit/branch.test.ts` (add a case)

**Interfaces:**
- Produces: `branchAndCherryPick(opts): Promise<{ emptyPicks: string[] }>` (was `Promise<void>`). Existing callers that ignore the return continue to work.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/branch.test.ts` (inside the existing `describe`):

```ts
  it("records and skips a carry whose change is already present on the base", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "branch-empty-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "t"], { cwd: repo });
    // base commit
    await fs.writeFile(path.join(repo, "main.txt"), "main", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "base"], { cwd: repo });
    // base ALSO contains shared.txt="s" (simulates upstream already having it)
    await fs.writeFile(path.join(repo, "shared.txt"), "s", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "shared upstream"], { cwd: repo });
    await execa("git", ["tag", "v1"], { cwd: repo });
    // a fork branch off the base that adds the SAME shared.txt="s"
    await execa("git", ["checkout", "-b", "feature", "HEAD~1"], { cwd: repo });
    await fs.writeFile(path.join(repo, "shared.txt"), "s", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "carry shared"], { cwd: repo });
    const { stdout: carrySha } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });

    const result = await branchAndCherryPick({
      repoDir: repo,
      newBranch: "fork/v1",
      baseRef: "v1",
      shas: [carrySha.trim()],
    });

    expect(result.emptyPicks).toEqual([carrySha.trim()]);
    // the run continued and the branch exists
    const { stdout: branches } = await execa("git", ["branch", "--list", "fork/v1"], { cwd: repo });
    expect(branches).toContain("fork/v1");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- branch`
Expected: FAIL — `result.emptyPicks` is undefined; the absorbed pick currently routes to the conflict path and throws.

- [ ] **Step 3: Implement the empty-commit net**

Replace the body of `src/branch.ts` from the function signature down with:

```ts
export type BranchResult = { emptyPicks: string[] };

export async function branchAndCherryPick(opts: BranchOptions): Promise<BranchResult> {
  const emptyPicks: string[] = [];
  await execa("git", ["checkout", "-b", opts.newBranch, opts.baseRef], { cwd: opts.repoDir });
  for (const sha of opts.shas) {
    try {
      await execa("git", ["cherry-pick", sha], { cwd: opts.repoDir });
    } catch (err) {
      const e = err as ExecaError;
      const conflicts = await listConflicts(opts.repoDir);
      if (conflicts.length === 0) {
        // No conflicted files: the carry is already present upstream (absorbed),
        // so the cherry-pick is empty. Record it and skip; do not treat as conflict.
        await execa("git", ["cherry-pick", "--skip"], { cwd: opts.repoDir }).catch(() => {});
        emptyPicks.push(sha);
        continue;
      }
      const retry = opts.onConflict ? await opts.onConflict(sha, conflicts) : false;
      if (retry) {
        await execa("git", ["cherry-pick", "--continue"], { cwd: opts.repoDir });
      } else {
        await execa("git", ["cherry-pick", "--abort"], { cwd: opts.repoDir }).catch(() => {});
        throw new Error(
          `cherry-pick of ${sha} failed; conflicts: ${conflicts.join(", ")}\n${e.stderr ?? e.message}`,
        );
      }
    }
  }
  return { emptyPicks };
}
```

Keep the existing `listConflicts` helper and `BranchOptions` type unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- branch`
Expected: PASS — new empty-pick test green; existing cherry-pick test green (it ignores the return value).

- [ ] **Step 5: Commit**

```bash
git add src/branch.ts tests/unit/branch.test.ts
git commit -m "feat(branch): record and skip absorbed (empty) cherry-picks (#9)"
```

### Task 8: `verifyCarryIntegrity`

**Files:**
- Create: `src/carry-integrity.ts`
- Test: `tests/unit/carry-integrity.test.ts` (create)

**Interfaces:**
- Consumes: `CarryEntry` (with `landed_markers` — added in this task's schema step).
- Produces:
  - `type IntegrityFinding = { sha: string; subject: string; kind: "missing-marker" | "empty-pick"; detail: string }`
  - `verifyCarryIntegrity(params: { repoDir: string; carries: CarryEntry[]; emptyPicks: string[] }): Promise<IntegrityFinding[]>`

- [ ] **Step 1: Add the `landed_markers` schema field**

In `src/carry-manifest.ts`, add to `CarryEntrySchema` (alongside `enabled`/`pin`):

```ts
  landed_markers: z.array(z.string()).optional().default([]),
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/carry-integrity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";
import { resolveCarryList } from "../../src/carry-manifest.js";
import { verifyCarryIntegrity } from "../../src/carry-integrity.js";

async function repoWith(fileBody: string) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "integrity-"));
  await execa("git", ["init", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.email", "t@e.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "t"], { cwd: repo });
  await fs.writeFile(path.join(repo, "code.ts"), fileBody, "utf-8");
  await execa("git", ["add", "."], { cwd: repo });
  await execa("git", ["commit", "-m", "c"], { cwd: repo });
  return repo;
}

async function keptFrom(root: string, tomlBody: string) {
  await fs.writeFile(path.join(root, ".fork-upgrade-carry.toml"), tomlBody, "utf-8");
  const resolved = await resolveCarryList({
    manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
    upstreamRepo: "o/r",
    ghPrState: async () => "unknown",
  });
  return resolved.kept;
}

describe("verifyCarryIntegrity", () => {
  it("flags a declared marker that is absent from the tree", async () => {
    const repo = await repoWith("export const present = 1;\n");
    const carries = await keptFrom(repo, `
[[commits]]
sha = "aaa111"
subject = "adds a symbol"
landed_markers = ["onTrustedDiagnosticEvent"]
`);
    const findings = await verifyCarryIntegrity({ repoDir: repo, carries, emptyPicks: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("missing-marker");
    expect(findings[0].sha).toBe("aaa111");
  });

  it("passes when every declared marker is present", async () => {
    const repo = await repoWith("export function onTrustedDiagnosticEvent() {}\n");
    const carries = await keptFrom(repo, `
[[commits]]
sha = "aaa111"
subject = "adds a symbol"
landed_markers = ["onTrustedDiagnosticEvent"]
`);
    const findings = await verifyCarryIntegrity({ repoDir: repo, carries, emptyPicks: [] });
    expect(findings).toEqual([]);
  });

  it("flags an empty (absorbed) pick", async () => {
    const repo = await repoWith("anything\n");
    const carries = await keptFrom(repo, `
[[commits]]
sha = "bbb222"
subject = "absorbed carry"
`);
    const findings = await verifyCarryIntegrity({ repoDir: repo, carries, emptyPicks: ["bbb222"] });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("empty-pick");
    expect(findings[0].sha).toBe("bbb222");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- carry-integrity`
Expected: FAIL — `src/carry-integrity.js` does not exist.

- [ ] **Step 4: Implement `src/carry-integrity.ts`**

```ts
import { execa } from "execa";
import type { CarryEntry } from "./carry-manifest.js";

export type IntegrityFinding = {
  sha: string;
  subject: string;
  kind: "missing-marker" | "empty-pick";
  detail: string;
};

async function markerPresent(repoDir: string, marker: string): Promise<boolean> {
  try {
    await execa("git", ["grep", "-F", "-q", "--", marker], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

export async function verifyCarryIntegrity(params: {
  repoDir: string;
  carries: CarryEntry[];
  emptyPicks: string[];
}): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  const empty = new Set(params.emptyPicks);
  for (const c of params.carries) {
    if (empty.has(c.sha)) {
      findings.push({
        sha: c.sha,
        subject: c.subject,
        kind: "empty-pick",
        detail: "cherry-pick produced no changes (already upstream or absorbed)",
      });
    }
    for (const marker of c.landed_markers) {
      if (!(await markerPresent(params.repoDir, marker))) {
        findings.push({
          sha: c.sha,
          subject: c.subject,
          kind: "missing-marker",
          detail: `expected marker not found in tree: ${marker}`,
        });
      }
    }
  }
  return findings;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- carry-integrity`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/carry-manifest.ts src/carry-integrity.ts tests/unit/carry-integrity.test.ts
git commit -m "feat(carry): verifyCarryIntegrity markers + empty-pick findings (#9)"
```

### Task 9: Wire integrity check + checkpoint into `index.ts` + integration

**Files:**
- Modify: `src/state.ts` (add optional `notes?: string[]`)
- Modify: `src/index.ts` (capture `emptyPicks`, run verify, checkpoint)
- Test: `tests/integration/carry-integrity.test.ts` (create)

**Interfaces:**
- Consumes: `branchAndCherryPick` returning `{ emptyPicks }` (Task 7), `verifyCarryIntegrity` (Task 8), `prompt` (existing).

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/carry-integrity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { buildFixtureUpstreamAndFork } from "../fixtures/build-fixture-repos.js";

describe("carry-integrity checkpoint", () => {
  it("warns about a missing landed_marker before cutover and proceeds with --yes", async () => {
    const { fork } = await buildFixtureUpstreamAndFork();
    const { stdout: forkSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: fork });
    await fs.writeFile(
      path.join(fork, ".fork-upgrade.toml"),
      `
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
      `,
      "utf-8",
    );
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-carry.toml"),
      `
[[commits]]
sha = "${forkSha.trim()}"
subject = "fork carry"
landed_markers = ["NONEXISTENT_MARKER_XYZ"]
      `,
      "utf-8",
    );

    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [distEntry, "--tag", "v2", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );

    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    const combined = stdout + stderr;
    expect(combined).toContain("carry-integrity warnings");
    expect(combined).toContain("missing-marker");
    // proceeded through to probes (warning surfaced BEFORE cutover/probes)
    expect(combined).toContain("probes: GREEN");
    expect(combined.indexOf("carry-integrity warnings")).toBeLessThan(combined.indexOf("probes: GREEN"));
  });
});
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build && npm test -- integration/carry-integrity`
Expected: FAIL — no "carry-integrity warnings" output (not wired yet).

- [ ] **Step 3: Add optional `notes` to state**

In `src/state.ts`, extend the `State` type:

```ts
export type State = {
  phase: Phase;
  tag: string;
  forkBranch: string;
  startedAt: number;
  notes?: string[];
};
```

(`writeState` already spreads `...state`, so `notes` flows through with no further change.)

- [ ] **Step 4: Wire verify + checkpoint into `src/index.ts`**

Add the import:

```ts
import { verifyCarryIntegrity } from "./carry-integrity.js";
```

Replace:

```ts
  await writeState(stateFile, { phase: "branch", tag, forkBranch });
  await branchAndCherryPick({
    repoDir,
    newBranch: forkBranch,
    baseRef: tag,
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
```

with:

```ts
  await writeState(stateFile, { phase: "branch", tag, forkBranch });
  const branchResult = await branchAndCherryPick({
    repoDir,
    newBranch: forkBranch,
    baseRef: tag,
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

  const integrity = await verifyCarryIntegrity({
    repoDir,
    carries: carry.kept,
    emptyPicks: branchResult.emptyPicks,
  });
  if (integrity.length > 0) {
    console.warn("carry-integrity warnings:");
    for (const f of integrity) {
      console.warn(`  [${f.kind}] ${f.sha} ${f.subject}: ${f.detail}`);
    }
    await writeState(stateFile, {
      phase: "branch",
      tag,
      forkBranch,
      notes: integrity.map((f) => `${f.kind}:${f.sha}:${f.detail}`),
    });
    const ans = await prompt({
      message: "Carry-integrity warnings above. Proceed anyway?",
      options: ["proceed", "abort"],
      yes: values.yes,
    });
    if (ans !== "proceed") return;
  }
```

- [ ] **Step 5: Build and run to verify it passes**

Run: `npm run build && npm test`
Expected: PASS — integrity integration test green; happy-path/rollback still green (their carry sets declare no markers and produce no empty picks).

- [ ] **Step 6: Commit**

```bash
git add src/state.ts src/index.ts tests/integration/carry-integrity.test.ts
git commit -m "feat(cli): carry-integrity checkpoint before cutover (#9)"
```

---

## Final verification (per PR and at end of M1)

- [ ] `npm run build` — clean (tsc).
- [ ] `npm test` — full suite green.
- [ ] Update `README.md` "Carry manifest" section to document `enabled`, `pin`, `landed_markers`, and the `upstream_search` advisory + integrity checkpoint behavior (fold into the PR that introduces each field; do NOT leave README stale). Remove the "`upstream_search` … not yet auto-queried" and "single-tag" caveats only where they become untrue (search caveat in PR 3; leave the multi-tag caveat — that's M2).

## Self-review notes (addressed)

- **Spec coverage:** Unit A → Tasks 1–2; Unit B → Tasks 3–4; Unit C → Tasks 5–6; Unit D → Tasks 7–9. Example carry-12 update (spec Unit B) → Task 4 Step 5. State/journal recording of findings (spec Unit D) → Task 9 Step 3.
- **Type consistency:** `resolveCarryList` returns `{ kept, landed, parked }` (Task 3) and every later consumer reads `carry.kept`/`carry.parked`. `branchAndCherryPick` returns `{ emptyPicks }` (Task 7) consumed in Task 9. `GhSearchFn`/`GhSearchHit`/`IntegrityFinding` names match across definition and use.
- **No placeholders:** every code/test step contains complete, runnable content.
