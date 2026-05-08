import { execa, type ExecaError } from "execa";

export type BranchOptions = {
  repoDir: string;
  newBranch: string;
  baseRef: string;
  shas: string[];
  /** Called when a cherry-pick conflicts. Resolve to true to retry, false to abort. */
  onConflict?: (sha: string, conflictedFiles: string[]) => Promise<boolean>;
};

export async function branchAndCherryPick(opts: BranchOptions): Promise<void> {
  await execa("git", ["checkout", "-b", opts.newBranch, opts.baseRef], { cwd: opts.repoDir });
  for (const sha of opts.shas) {
    try {
      await execa("git", ["cherry-pick", sha], { cwd: opts.repoDir });
    } catch (err) {
      const e = err as ExecaError;
      const conflicts = await listConflicts(opts.repoDir);
      const retry = opts.onConflict ? await opts.onConflict(sha, conflicts) : false;
      if (retry) {
        await execa("git", ["cherry-pick", "--continue"], { cwd: opts.repoDir });
      } else {
        await execa("git", ["cherry-pick", "--abort"], { cwd: opts.repoDir }).catch(() => {});
        throw new Error(
          `cherry-pick of ${sha} failed; conflicts: ${conflicts.join(", ")}\n${e.stderr ?? e.message}`,
        );
      }
    }
  }
}

async function listConflicts(repoDir: string): Promise<string[]> {
  const { stdout } = await execa("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: repoDir,
  });
  return stdout.split("\n").filter(Boolean);
}
