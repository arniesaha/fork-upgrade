import { execa } from "execa";
import fs from "node:fs/promises";

export async function runRollback(opts: {
  repoDir: string;
  anchorTag: string;
  configRestores: { live: string; snapshot: string }[];
}): Promise<void> {
  await execa("git", ["checkout", opts.anchorTag], { cwd: opts.repoDir });
  for (const r of opts.configRestores) {
    await fs.copyFile(r.snapshot, r.live);
  }
}
