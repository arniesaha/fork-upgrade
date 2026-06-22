import { execa, type ExecaError } from "execa";

export type BranchOptions = {
  repoDir: string;
  newBranch: string;
  baseRef: string;
  shas: string[];
  force?: boolean;
  /** Called when a cherry-pick conflicts. Resolve to true to retry, false to abort. */
  onConflict?: (sha: string, conflictedFiles: string[]) => Promise<boolean>;
};

export type BranchResult = { emptyPicks: string[] };

export async function branchAndCherryPick(opts: BranchOptions): Promise<BranchResult> {
  const emptyPicks: string[] = [];
  await execa("git", ["checkout", opts.force ? "-B" : "-b", opts.newBranch, opts.baseRef], { cwd: opts.repoDir });
  for (const sha of opts.shas) {
    try {
      await execa("git", ["cherry-pick", sha], { cwd: opts.repoDir });
    } catch (err) {
      const e = err as ExecaError;
      const conflicts = await listConflicts(opts.repoDir);
      if (conflicts.length === 0) {
        // No conflicted files — two distinct cases:
        // 1. CHERRY_PICK_HEAD exists: genuine absorbed/empty pick — skip and record.
        // 2. CHERRY_PICK_HEAD absent: hard failure (e.g. merge commit without -m) — throw.
        if (await cherryPickInProgress(opts.repoDir)) {
          await execa("git", ["cherry-pick", "--skip"], { cwd: opts.repoDir });
          emptyPicks.push(sha);
          continue;
        }
        throw new Error(
          `cherry-pick of ${sha} failed with no conflicts and no CHERRY_PICK_HEAD (hard failure — e.g. merge commit without -m): ${e.stderr ?? e.message}`,
        );
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

/** Returns true when a cherry-pick is in progress (CHERRY_PICK_HEAD exists). */
async function cherryPickInProgress(repoDir: string): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

async function listConflicts(repoDir: string): Promise<string[]> {
  const { stdout } = await execa("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: repoDir,
  });
  return stdout.split("\n").filter(Boolean);
}
