import { execa } from "execa";
import type { CarryEntry } from "./carry-manifest.js";

export type IntegrityFinding = {
  sha: string;
  subject: string;
  kind: "missing-marker" | "empty-pick";
  detail: string;
};

async function markerPresent(repoDir: string, marker: string): Promise<boolean> {
  try {
    await execa("git", ["grep", "-F", "-q", "--", marker], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

export async function verifyCarryIntegrity(params: {
  repoDir: string;
  carries: CarryEntry[];
  emptyPicks: string[];
}): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  const empty = new Set(params.emptyPicks);
  for (const c of params.carries) {
    if (empty.has(c.sha)) {
      findings.push({
        sha: c.sha,
        subject: c.subject,
        kind: "empty-pick",
        detail: "cherry-pick produced no changes (already upstream or absorbed)",
      });
    }
    for (const marker of c.landed_markers) {
      if (!(await markerPresent(params.repoDir, marker))) {
        findings.push({
          sha: c.sha,
          subject: c.subject,
          kind: "missing-marker",
          detail: `expected marker not found in tree: ${marker}`,
        });
      }
    }
  }
  return findings;
}
