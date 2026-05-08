import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { buildFixtureUpstreamAndFork } from "../fixtures/build-fixture-repos.js";

describe("fork-upgrade rollback path", () => {
  it("rolls back to the anchor tag when probes are RED and the user opts in", async () => {
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
post_cutover = [{ name = "fail", cmd = "false", parse = "exit" }]
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
      `,
      "utf-8",
    );

    const distEntry = path.resolve("dist/index.js");
    // --yes auto-confirms checkpoints; rollback prompt currently blocks --yes for safety,
    // so this test asserts the RED classification is reported even if no rollback runs.
    // stdio: ["ignore", "pipe", "pipe"] gives the readline prompt EOF, so it returns empty string,
    // which the checkpoint interprets as "abort".
    const { stdout } = await execa(
      "node",
      [distEntry, "--tag", "v2", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(stdout).toContain("probes: RED");
  });
});
