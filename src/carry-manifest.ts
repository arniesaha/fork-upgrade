import fs from "node:fs/promises";
import toml from "@iarna/toml";
import { z } from "zod";
import { execa } from "execa";

const CarryEntrySchema = z.object({
  sha: z.string(),
  subject: z.string(),
  upstream_pr: z.string().optional().default(""),
  upstream_search: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
  pin: z.boolean().optional().default(false),
  landed_markers: z.array(z.string()).optional().default([]),
});

const CarryManifestSchema = z.object({
  commits: z.array(CarryEntrySchema).default([]),
});

export type CarryEntry = z.infer<typeof CarryEntrySchema>;

export type ResolvedCarryList = {
  kept: CarryEntry[];
  landed: CarryEntry[];
  parked: CarryEntry[];
};

export type GhPrStateFn = (
  pr: string,
  upstreamRepo: string,
) => Promise<"merged" | "open" | "closed" | "unknown">;

export async function resolveCarryList(params: {
  manifestPath: string;
  upstreamRepo: string;
  ghPrState: GhPrStateFn;
}): Promise<ResolvedCarryList> {
  const raw = await fs.readFile(params.manifestPath, "utf-8");
  const parsed = CarryManifestSchema.parse(toml.parse(raw));
  const kept: CarryEntry[] = [];
  const landed: CarryEntry[] = [];
  const parked: CarryEntry[] = [];
  for (const entry of parsed.commits) {
    if (!entry.enabled) {
      parked.push(entry);
      continue;
    }
    if (entry.pin) {
      kept.push(entry);
      continue;
    }
    if (entry.upstream_pr) {
      const state = await params.ghPrState(entry.upstream_pr, params.upstreamRepo);
      if (state === "merged") {
        landed.push(entry);
        continue;
      }
    }
    kept.push(entry);
  }
  return { kept, landed, parked };
}

export const ghPrStateFromCli: GhPrStateFn = async (pr, upstreamRepo) => {
  try {
    const { stdout } = await execa("gh", [
      "pr",
      "view",
      pr,
      "--repo",
      upstreamRepo,
      "--json",
      "state",
      "--jq",
      ".state",
    ]);
    const trimmed = stdout.trim().toLowerCase();
    if (trimmed === "merged") return "merged";
    if (trimmed === "open") return "open";
    if (trimmed === "closed") return "closed";
    return "unknown";
  } catch {
    return "unknown";
  }
};

export async function assertCarryShasExist(params: {
  repoDir: string;
  entries: CarryEntry[];
}): Promise<{ ok: boolean; missing: CarryEntry[] }> {
  const missing: CarryEntry[] = [];
  for (const entry of params.entries) {
    try {
      await execa(
        "git",
        ["rev-parse", "--verify", "--quiet", `${entry.sha}^{commit}`],
        { cwd: params.repoDir },
      );
    } catch {
      missing.push(entry);
    }
  }
  return { ok: missing.length === 0, missing };
}

export type GhSearchHit = { sha: string; url: string; subject: string };
export type GhSearchFn = (query: string, upstreamRepo: string) => Promise<GhSearchHit[]>;

export async function searchUpstreamForCarries(params: {
  entries: CarryEntry[];
  upstreamRepo: string;
  ghSearch: GhSearchFn;
}): Promise<Array<{ entry: CarryEntry; hits: GhSearchHit[] }>> {
  const advisories: Array<{ entry: CarryEntry; hits: GhSearchHit[] }> = [];
  for (const entry of params.entries) {
    if (!entry.upstream_search) continue;
    const hits = await params.ghSearch(entry.upstream_search, params.upstreamRepo);
    if (hits.length > 0) advisories.push({ entry, hits });
  }
  return advisories;
}

export const ghSearchFromCli: GhSearchFn = async (query, upstreamRepo) => {
  try {
    const { stdout } = await execa("gh", [
      "search",
      "commits",
      query,
      "--repo",
      upstreamRepo,
      "--limit",
      "3",
      "--json",
      "sha,url,commit",
    ]);
    const rows = JSON.parse(stdout) as Array<{
      sha?: string;
      url?: string;
      commit?: { message?: string };
    }>;
    return rows.map((r) => ({
      sha: r.sha ?? "",
      url: r.url ?? "",
      subject: (r.commit?.message ?? "").split("\n")[0],
    }));
  } catch {
    return [];
  }
};
