import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";

export type BackupOptions = {
  repoDir: string;
  anchorTag: string;
  pushAnchor: boolean;
  originRemote?: string;
  configFiles: string[];
  configSnapshotSuffix: string;
  stateArchive?: { paths: string[]; output: string };
};

export async function runBackup(opts: BackupOptions): Promise<void> {
  await execa("git", ["tag", opts.anchorTag], { cwd: opts.repoDir });
  if (opts.pushAnchor) {
    await execa("git", ["push", opts.originRemote ?? "origin", opts.anchorTag], {
      cwd: opts.repoDir,
    });
  }
  for (const cfgPath of opts.configFiles) {
    const expanded = cfgPath.startsWith("~/")
      ? path.join(process.env.HOME ?? "", cfgPath.slice(2))
      : cfgPath;
    const snapshot = `${expanded}${opts.configSnapshotSuffix}`;
    await fs.copyFile(expanded, snapshot);
  }
  if (opts.stateArchive) {
    const args = ["-czf", opts.stateArchive.output];
    for (const p of opts.stateArchive.paths) {
      const expanded = p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p;
      args.push("-C", path.dirname(expanded), path.basename(expanded));
    }
    await execa("tar", args);
  }
}
