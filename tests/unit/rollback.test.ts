import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";
import { runRollback } from "../../src/rollback.js";

describe("runRollback", () => {
  it("checks out the anchor tag and restores config snapshots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollback-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "t"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "v1", "utf-8");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "v1"], { cwd: repo });
    await execa("git", ["tag", "anchor/v1"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "v2", "utf-8");
    await execa("git", ["commit", "-am", "v2"], { cwd: repo });

    const cfgPath = path.join(root, "live.json");
    await fs.writeFile(cfgPath, "current", "utf-8");
    await fs.writeFile(`${cfgPath}.snapshot`, "snapshot", "utf-8");

    await runRollback({
      repoDir: repo,
      anchorTag: "anchor/v1",
      configRestores: [{ live: cfgPath, snapshot: `${cfgPath}.snapshot` }],
    });

    const { stdout } = await execa("git", ["log", "--oneline"], { cwd: repo });
    expect(stdout.split("\n").length).toBe(1);
    expect(await fs.readFile(cfgPath, "utf-8")).toBe("snapshot");
  });
});
