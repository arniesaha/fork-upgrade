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
