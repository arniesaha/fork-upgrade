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
