import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";
import { branchAndCherryPick } from "../../src/branch.js";

describe("branchAndCherryPick", () => {
  it("creates the new branch from the target ref and cherry-picks each carry sha", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "branch-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "t"], { cwd: repo });
    await fs.writeFile(path.join(repo, "main.txt"), "main", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "main commit"], { cwd: repo });
    await execa("git", ["tag", "v1"], { cwd: repo });

    await execa("git", ["checkout", "-b", "feature"], { cwd: repo });
    await fs.writeFile(path.join(repo, "feat.txt"), "f", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "feat commit"], { cwd: repo });
    const { stdout: featSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });

    await branchAndCherryPick({
      repoDir: repo,
      newBranch: "fork/v1",
      baseRef: "v1",
      shas: [featSha.trim()],
    });

    const { stdout: branchTip } = await execa("git", ["log", "--oneline", "-2"], { cwd: repo });
    expect(branchTip).toContain("feat commit");
    expect(branchTip).toContain("main commit");
  });

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

  it("rejects when cherry-picking a merge commit without -m (hard failure, not absorbed)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "branch-merge-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "t"], { cwd: repo });
    // initial commit on default branch → tag v1
    await fs.writeFile(path.join(repo, "main.txt"), "main", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "base"], { cwd: repo });
    await execa("git", ["tag", "v1"], { cwd: repo });
    // create feature branch off v1
    await execa("git", ["checkout", "-b", "feature"], { cwd: repo });
    await fs.writeFile(path.join(repo, "feature.txt"), "f", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "feature commit"], { cwd: repo });
    // go back to default branch and add another commit
    await execa("git", ["checkout", "-"], { cwd: repo });
    await fs.writeFile(path.join(repo, "extra.txt"), "e", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "extra on main"], { cwd: repo });
    // create a merge commit (no-ff)
    await execa(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "merge", "--no-ff", "feature", "-m", "merge feature"],
      { cwd: repo },
    );
    const { stdout: mergeShaRaw } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });
    const mergeSha = mergeShaRaw.trim();

    // Attempting to cherry-pick a merge commit without -m must REJECT (hard failure),
    // not silently absorb it into emptyPicks.
    await expect(
      branchAndCherryPick({
        repoDir: repo,
        newBranch: "fork/v1",
        baseRef: "v1",
        shas: [mergeSha],
      }),
    ).rejects.toThrow();
  });

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
});
