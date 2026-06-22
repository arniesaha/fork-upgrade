import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";
import { resolveCarryList } from "../../src/carry-manifest.js";
import { verifyCarryIntegrity } from "../../src/carry-integrity.js";

async function repoWith(fileBody: string) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "integrity-"));
  await execa("git", ["init", "-b", "main"], { cwd: repo });
  await execa("git", ["config", "user.email", "t@e.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "t"], { cwd: repo });
  await fs.writeFile(path.join(repo, "code.ts"), fileBody, "utf-8");
  await execa("git", ["add", "."], { cwd: repo });
  await execa("git", ["commit", "-m", "c"], { cwd: repo });
  return repo;
}

async function keptFrom(root: string, tomlBody: string) {
  await fs.writeFile(path.join(root, ".fork-upgrade-carry.toml"), tomlBody, "utf-8");
  const resolved = await resolveCarryList({
    manifestPath: path.join(root, ".fork-upgrade-carry.toml"),
    upstreamRepo: "o/r",
    ghPrState: async () => "unknown",
  });
  return resolved.kept;
}

describe("verifyCarryIntegrity", () => {
  it("flags a declared marker that is absent from the tree", async () => {
    const repo = await repoWith("export const present = 1;\n");
    const carries = await keptFrom(repo, `
[[commits]]
sha = "aaa111"
subject = "adds a symbol"
landed_markers = ["onTrustedDiagnosticEvent"]
`);
    const findings = await verifyCarryIntegrity({ repoDir: repo, carries, emptyPicks: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("missing-marker");
    expect(findings[0].sha).toBe("aaa111");
  });

  it("passes when every declared marker is present", async () => {
    const repo = await repoWith("export function onTrustedDiagnosticEvent() {}\n");
    const carries = await keptFrom(repo, `
[[commits]]
sha = "aaa111"
subject = "adds a symbol"
landed_markers = ["onTrustedDiagnosticEvent"]
`);
    const findings = await verifyCarryIntegrity({ repoDir: repo, carries, emptyPicks: [] });
    expect(findings).toEqual([]);
  });

  it("flags an empty (absorbed) pick", async () => {
    const repo = await repoWith("anything\n");
    const carries = await keptFrom(repo, `
[[commits]]
sha = "bbb222"
subject = "absorbed carry"
`);
    const findings = await verifyCarryIntegrity({ repoDir: repo, carries, emptyPicks: ["bbb222"] });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("empty-pick");
    expect(findings[0].sha).toBe("bbb222");
  });
});
