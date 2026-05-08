import fs from "node:fs/promises";
import toml from "@iarna/toml";
import { z } from "zod";
import { execa } from "execa";

const CarryEntrySchema = z.object({
  sha: z.string(),
  subject: z.string(),
  upstream_pr: z.string().optional().default(""),
  upstream_search: z.string().optional().default(""),
});

const CarryManifestSchema = z.object({
  commits: z.array(CarryEntrySchema).default([]),
});

export type CarryEntry = z.infer<typeof CarryEntrySchema>;

export type ResolvedCarryList = {
  kept: CarryEntry[];
  landed: CarryEntry[];
};

export type GhPrStateFn = (pr: string) => Promise<"merged" | "open" | "closed" | "unknown">;

export async function resolveCarryList(params: {
  manifestPath: string;
  upstreamRepo: string;
  ghPrState: GhPrStateFn;
}): Promise<ResolvedCarryList> {
  const raw = await fs.readFile(params.manifestPath, "utf-8");
  const parsed = CarryManifestSchema.parse(toml.parse(raw));
  const kept: CarryEntry[] = [];
  const landed: CarryEntry[] = [];
  for (const entry of parsed.commits) {
    if (entry.upstream_pr) {
      const state = await params.ghPrState(entry.upstream_pr);
      if (state === "merged") {
        landed.push(entry);
        continue;
      }
    }
    kept.push(entry);
  }
  return { kept, landed };
}

export const ghPrStateFromCli: GhPrStateFn = async (pr) => {
  try {
    const { stdout } = await execa("gh", ["pr", "view", pr, "--json", "state", "--jq", ".state"]);
    const trimmed = stdout.trim().toLowerCase();
    if (trimmed === "merged") return "merged";
    if (trimmed === "open") return "open";
    if (trimmed === "closed") return "closed";
    return "unknown";
  } catch {
    return "unknown";
  }
};
