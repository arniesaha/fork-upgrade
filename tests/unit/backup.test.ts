import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";
import { runBackup } from "../../src/backup.js";

async function initRepo(dir: string) {
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "t"], { cwd: dir });
  await fs.writeFile(path.join(dir, "a.txt"), "x", "utf-8");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
}

describe("runBackup", () => {
  it("creates the anchor tag and copies config files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await initRepo(repo);
    const cfgPath = path.join(root, "live.json");
    await fs.writeFile(cfgPath, '{"a":1}', "utf-8");

    await runBackup({
      repoDir: repo,
      anchorTag: "pre-migration/test",
      pushAnchor: false,
      configFiles: [cfgPath],
      configSnapshotSuffix: ".pre-test",
      stateArchive: undefined,
    });

    const { stdout } = await execa("git", ["tag", "-l", "pre-migration/test"], { cwd: repo });
    expect(stdout.trim()).toBe("pre-migration/test");
    const snapshotRaw = await fs.readFile(`${cfgPath}.pre-test`, "utf-8");
    expect(snapshotRaw).toBe('{"a":1}');
  });
});
