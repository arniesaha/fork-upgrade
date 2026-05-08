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
});
