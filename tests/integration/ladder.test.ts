import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";

const CONFIG = `
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
`;

// Build an upstream with v1,v2,v2.1-rc,v3 and a fork on v1 with one carry commit.
async function buildLadderRepo(): Promise<{ fork: string; carrySha: string }> {
  const root = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "m2-ladder-"));
  const upstream = path.join(root, "upstream");
  const fork = path.join(root, "fork");
  await fs.mkdir(upstream);
  await execa("git", ["init", "-b", "main"], { cwd: upstream });
  await execa("git", ["config", "user.email", "u@e.com"], { cwd: upstream });
  await execa("git", ["config", "user.name", "u"], { cwd: upstream });
  for (const v of ["v1", "v2", "v2.1-rc", "v3"]) {
    await fs.writeFile(path.join(upstream, "main.txt"), v, "utf-8");
    await execa("git", ["add", "."], { cwd: upstream });
    await execa("git", ["commit", "-m", v], { cwd: upstream });
    await execa("git", ["tag", v], { cwd: upstream });
  }
  await execa("git", ["clone", upstream, fork]);
  await execa("git", ["config", "user.email", "f@e.com"], { cwd: fork });
  await execa("git", ["config", "user.name", "f"], { cwd: fork });
  await execa("git", ["remote", "add", "upstream", upstream], { cwd: fork });
  await execa("git", ["fetch", "upstream", "--tags"], { cwd: fork });
  await execa("git", ["checkout", "-b", "fork/v1", "v1"], { cwd: fork });
  await fs.writeFile(path.join(fork, "carry.txt"), "carry", "utf-8");
  await execa("git", ["add", "."], { cwd: fork });
  await execa("git", ["commit", "-m", "fork carry"], { cwd: fork });
  const { stdout: carrySha } = await execa("git", ["rev-parse", "HEAD"], { cwd: fork });
  return { fork, carrySha: carrySha.trim() };
}

describe("multi-tag ladder", () => {
  it("walks intermediate stable tags, excludes pre-releases, cuts over only on the final hop", async () => {
    const { fork, carrySha } = await buildLadderRepo();
    await fs.writeFile(path.join(fork, ".fork-upgrade.toml"), CONFIG, "utf-8");
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-carry.toml"),
      `\n[[commits]]\nsha = "${carrySha}"\nsubject = "fork carry"\n`,
      "utf-8",
    );
    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [distEntry, "--tag", "v3", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("tag ladder: v2 -> v3"); // rc excluded
    expect(stdout).not.toContain("v2.1-rc");
    // cutover/probes only once (final hop v3)
    expect(stdout.match(/probes: GREEN/g)?.length).toBe(1);
    // final branch exists; intermediate branch was deleted
    const { stdout: v3 } = await execa("git", ["branch", "--list", "fork/v3"], { cwd: fork });
    const { stdout: v2 } = await execa("git", ["branch", "--list", "fork/v2"], { cwd: fork });
    expect(v3).toContain("fork/v3");
    expect(v2.trim()).toBe("");
  });

  it("--single-tag skips enumeration and jumps straight to the target", async () => {
    const { fork, carrySha } = await buildLadderRepo();
    await fs.writeFile(path.join(fork, ".fork-upgrade.toml"), CONFIG, "utf-8");
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-carry.toml"),
      `\n[[commits]]\nsha = "${carrySha}"\nsubject = "fork carry"\n`,
      "utf-8",
    );
    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [distEntry, "--tag", "v3", "--upstream-repo", "fixture/repo", "--single-tag", "--yes"],
      { cwd: fork, reject: false },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("tag ladder: v3");
    expect(stdout).not.toContain("v2 -> v3");
  });
});
