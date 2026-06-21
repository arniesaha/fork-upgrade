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
