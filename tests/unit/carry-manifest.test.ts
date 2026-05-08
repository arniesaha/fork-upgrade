import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { resolveCarryList } from "../../src/carry-manifest.js";

describe("resolveCarryList", () => {
  it("marks a commit landed-upstream when its upstream_pr is merged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-"));
    await fs.writeFile(
      path.join(root, ".fork-upgrade-carry.toml"),
      `
[[commits]]
sha = "aaa111"
subject = "fix one"
upstream_pr = "1234"

[[commits]]
sha = "bbb222"
subject = "fix two"
upstream_pr = ""
      `,
      "utf-8",
    );

    const ghPrState = vi.fn(async (pr: string) => (pr === "1234" ? "merged" : "open"));
    const result = await resolveCarryList({
      manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
      upstreamRepo: "openclaw/openclaw",
      ghPrState,
    });

    expect(result.kept.map((c) => c.sha)).toEqual(["bbb222"]);
    expect(result.landed.map((c) => c.sha)).toEqual(["aaa111"]);
  });
});
