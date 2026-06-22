import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { resolveCarryList, searchUpstreamForCarries } from "../../src/carry-manifest.js";

async function keptFrom(tomlBody: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-search-"));
  await fs.writeFile(path.join(root, ".fork-upgrade-carry.toml"), tomlBody, "utf-8");
  const resolved = await resolveCarryList({
    manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
    upstreamRepo: "openclaw/openclaw",
    ghPrState: async () => "unknown",
  });
  return resolved.kept;
}

describe("searchUpstreamForCarries", () => {
  it("returns an advisory for a carry whose search query matches upstream", async () => {
    const kept = await keptFrom(`
[[commits]]
sha = "aaa111"
subject = "needs search"
upstream_search = "clientContext mapper"
`);
    const ghSearch = vi.fn(async () => [
      { sha: "deadbeef", url: "https://github.com/o/r/commit/deadbeef", subject: "add clientContext mapper" },
    ]);
    const advisories = await searchUpstreamForCarries({
      entries: kept,
      upstreamRepo: "openclaw/openclaw",
      ghSearch,
    });
    expect(advisories).toHaveLength(1);
    expect(advisories[0].entry.sha).toBe("aaa111");
    expect(advisories[0].hits[0].sha).toBe("deadbeef");
    expect(ghSearch).toHaveBeenCalledWith("clientContext mapper", "openclaw/openclaw");
  });

  it("skips carries with no upstream_search (never invokes ghSearch)", async () => {
    const kept = await keptFrom(`
[[commits]]
sha = "bbb222"
subject = "no search field"
`);
    const ghSearch = vi.fn(async () => [
      { sha: "x", url: "u", subject: "s" },
    ]);
    const advisories = await searchUpstreamForCarries({
      entries: kept,
      upstreamRepo: "openclaw/openclaw",
      ghSearch,
    });
    expect(advisories).toEqual([]);
    expect(ghSearch).not.toHaveBeenCalled();
  });
});
