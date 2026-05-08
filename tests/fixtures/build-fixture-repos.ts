import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function buildFixtureUpstreamAndFork(): Promise<{
  root: string;
  upstream: string;
  fork: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fork-upgrade-fixture-"));
  const upstream = path.join(root, "upstream");
  const fork = path.join(root, "fork");

  await fs.mkdir(upstream);
  await execa("git", ["init", "-b", "main"], { cwd: upstream });
  await execa("git", ["config", "user.email", "u@example.com"], {
    cwd: upstream,
  });
  await execa("git", ["config", "user.name", "u"], { cwd: upstream });

  await fs.writeFile(path.join(upstream, "main.txt"), "v1", "utf-8");
  await execa("git", ["add", "."], { cwd: upstream });
  await execa("git", ["commit", "-m", "v1"], { cwd: upstream });
  await execa("git", ["tag", "v1"], { cwd: upstream });

  await fs.writeFile(path.join(upstream, "main.txt"), "v2", "utf-8");
  await execa("git", ["commit", "-am", "v2"], { cwd: upstream });
  await execa("git", ["tag", "v2"], { cwd: upstream });

  await execa("git", ["clone", upstream, fork]);
  await execa("git", ["config", "user.email", "f@example.com"], {
    cwd: fork,
  });
  await execa("git", ["config", "user.name", "f"], { cwd: fork });
  await execa("git", ["remote", "add", "upstream", upstream], { cwd: fork });
  await execa("git", ["fetch", "upstream", "--tags"], { cwd: fork });

  await execa("git", ["checkout", "-b", "fork/v1", "v1"], { cwd: fork });
  await fs.writeFile(path.join(fork, "carry.txt"), "carry", "utf-8");
  await execa("git", ["add", "."], { cwd: fork });
  await execa("git", ["commit", "-m", "fork carry"], { cwd: fork });

  return { root, upstream, fork };
}
