import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
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

async function buildForkOnV1(): Promise<{ fork: string; carrySha: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m2-resume-"));
  const upstream = path.join(root, "upstream");
  const fork = path.join(root, "fork");
  await fs.mkdir(upstream);
  await execa("git", ["init", "-b", "main"], { cwd: upstream });
  await execa("git", ["config", "user.email", "u@e.com"], { cwd: upstream });
  await execa("git", ["config", "user.name", "u"], { cwd: upstream });
  for (const v of ["v1", "v2"]) {
    await fs.writeFile(path.join(upstream, "main.txt"), v, "utf-8");
    await execa("git", ["add", "."], { cwd: upstream });
    await execa("git", ["commit", "-m", v], { cwd: upstream });
    await execa("git", ["tag", v], { cwd: upstream });
  }
  await execa("git", ["clone", upstream, fork]);
  await execa("git", ["config", "user.email", "f@e.com"], { cwd: fork });
  await execa("git", ["config", "user.name", "f"], { cwd: fork });
  await execa("git", ["checkout", "-b", "fork/v2", "v2"], { cwd: fork }); // already on the hop branch
  await fs.writeFile(path.join(fork, "carry.txt"), "carry", "utf-8");
  await execa("git", ["add", "."], { cwd: fork });
  await execa("git", ["commit", "-m", "carry"], { cwd: fork });
  const { stdout: carrySha } = await execa("git", ["rev-parse", "HEAD"], { cwd: fork });
  return { fork, carrySha: carrySha.trim() };
}

describe("--resume", () => {
  it("resumes from the journaled hop and completes", async () => {
    const { fork, carrySha } = await buildForkOnV1();
    await fs.writeFile(path.join(fork, ".fork-upgrade.toml"), CONFIG, "utf-8");
    await fs.writeFile(path.join(fork, ".fork-upgrade-carry.toml"), `\n[[commits]]\nsha = "${carrySha}"\nsubject = "c"\n`, "utf-8");
    // journal pinned mid-run at the (only/final) hop, phase gates, HEAD already on fork/v2
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-state.json"),
      JSON.stringify({ phase: "gates", tag: "v2", forkBranch: "fork/v2", startedAt: 1, ladder: ["v2"], ladderIndex: 0, hopTag: "v2" }),
      "utf-8",
    );
    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [distEntry, "--resume", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("resuming from hop v2");
    expect(stdout).toContain("probes: GREEN");
  });

  it("refuses to resume when HEAD is not on the journaled hop branch", async () => {
    const { fork, carrySha } = await buildForkOnV1();
    await fs.writeFile(path.join(fork, ".fork-upgrade.toml"), CONFIG, "utf-8");
    await fs.writeFile(path.join(fork, ".fork-upgrade-carry.toml"), `\n[[commits]]\nsha = "${carrySha}"\nsubject = "c"\n`, "utf-8");
    await execa("git", ["checkout", "-b", "somewhere-else"], { cwd: fork });
    await fs.writeFile(
      path.join(fork, ".fork-upgrade-state.json"),
      JSON.stringify({ phase: "gates", tag: "v2", forkBranch: "fork/v2", startedAt: 1, ladder: ["v2"], ladderIndex: 0, hopTag: "v2" }),
      "utf-8",
    );
    const distEntry = path.resolve("dist/index.js");
    const { exitCode, stderr } = await execa(
      "node",
      [distEntry, "--resume", "--upstream-repo", "fixture/repo", "--yes"],
      { cwd: fork, reject: false },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("refusing to resume");
  });
});
