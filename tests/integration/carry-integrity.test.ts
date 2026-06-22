import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { buildFixtureUpstreamAndFork } from "../fixtures/build-fixture-repos.js";

describe("carry-integrity checkpoint", () => {
  it("warns about a missing landed_marker before cutover and proceeds with --yes", async () => {
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
landed_markers = ["NONEXISTENT_MARKER_XYZ"]
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
    const combined = stdout + stderr;
    expect(combined).toContain("carry-integrity warnings");
    expect(combined).toContain("missing-marker");
    // proceeded through to probes (warning surfaced before probes)
    expect(combined).toContain("probes: GREEN");
    expect(combined.indexOf("carry-integrity warnings")).toBeLessThan(combined.indexOf("probes: GREEN"));
  });
});
