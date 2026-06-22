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
