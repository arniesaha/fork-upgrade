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
    // PR state must be checked against the configured upstream repo, not the fork.
    expect(ghPrState).toHaveBeenCalledWith("1234", "openclaw/openclaw");
  });

  it("parks a disabled carry instead of keeping or landing it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-parked-"));
    await fs.writeFile(
      path.join(root, ".fork-upgrade-carry.toml"),
      `
[[commits]]
sha = "aaa111"
subject = "active"

[[commits]]
sha = "bbb222"
subject = "parked"
enabled = false
      `,
      "utf-8",
    );
    const ghPrState = vi.fn(async () => "unknown" as const);
    const result = await resolveCarryList({
      manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
      upstreamRepo: "openclaw/openclaw",
      ghPrState,
    });
    expect(result.kept.map((c) => c.sha)).toEqual(["aaa111"]);
    expect(result.parked.map((c) => c.sha)).toEqual(["bbb222"]);
    expect(result.landed).toEqual([]);
  });

  it("keeps a pinned carry even when its upstream_pr is merged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-pinned-"));
    await fs.writeFile(
      path.join(root, ".fork-upgrade-carry.toml"),
      `
[[commits]]
sha = "ccc333"
subject = "pinned load-bearing"
upstream_pr = "95608"
pin = true
      `,
      "utf-8",
    );
    const ghPrState = vi.fn(async () => "merged" as const);
    const result = await resolveCarryList({
      manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
      upstreamRepo: "openclaw/openclaw",
      ghPrState,
    });
    expect(result.kept.map((c) => c.sha)).toEqual(["ccc333"]);
    expect(result.landed).toEqual([]);
    // pinned carry never triggers a PR-state lookup
    expect(ghPrState).not.toHaveBeenCalled();
  });
});
