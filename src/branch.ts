import { execa, type ExecaError } from "execa";

export type BranchOptions = {
  repoDir: string;
  newBranch: string;
  baseRef: string;
  shas: string[];
  /** Called when a cherry-pick conflicts. Resolve to true to retry, false to abort. */
  onConflict?: (sha: string, conflictedFiles: string[]) => Promise<boolean>;
};

export type BranchResult = { emptyPicks: string[] };

export async function branchAndCherryPick(opts: BranchOptions): Promise<BranchResult> {
  const emptyPicks: string[] = [];
  await execa("git", ["checkout", "-b", opts.newBranch, opts.baseRef], { cwd: opts.repoDir });
  for (const sha of opts.shas) {
    try {
      await execa("git", ["cherry-pick", sha], { cwd: opts.repoDir });
    } catch (err) {
      const e = err as ExecaError;
      const conflicts = await listConflicts(opts.repoDir);
      if (conflicts.length === 0) {
        // No conflicted files: the carry is already present upstream (absorbed),
        // so the cherry-pick is empty. Record it and skip; do not treat as conflict.
        await execa("git", ["cherry-pick", "--skip"], { cwd: opts.repoDir }).catch(() => {});
        emptyPicks.push(sha);
        continue;
      }
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
  return { emptyPicks };
}

async function listConflicts(repoDir: string): Promise<string[]> {
  const { stdout } = await execa("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: repoDir,
  });
  return stdout.split("\n").filter(Boolean);
}
