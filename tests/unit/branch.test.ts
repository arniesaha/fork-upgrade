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
});
