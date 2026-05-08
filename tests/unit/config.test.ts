import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { loadConfig, substitute } from "../../src/config.js";

describe("loadConfig", () => {
  it("parses a minimal .fork-upgrade.toml", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-"));
    await fs.writeFile(
      path.join(root, ".fork-upgrade.toml"),
      `
[upstream]
remote = "upstream"
[fork]
origin_remote = "origin"
branch_pattern = "agentweave/{tag}"
[carry]
manifest = ".fork-upgrade-carry.toml"
[backup]
anchor_tag = "pre-migration/{fork_branch}"
[gates]
install = "pnpm install"
build = "pnpm build"
[cutover]
restart = "true"
verify = "true"
      `,
      "utf-8",
    );
    const cfg = await loadConfig(path.join(root, ".fork-upgrade.toml"));
    expect(cfg.upstream.remote).toBe("upstream");
    expect(cfg.fork.branch_pattern).toBe("agentweave/{tag}");
    expect(cfg.gates.install).toBe("pnpm install");
  });
});

describe("substitute", () => {
  it("replaces {tag} and {fork_branch} placeholders", () => {
    expect(substitute("agentweave/{tag}", { tag: "v2026.5.7" })).toBe("agentweave/v2026.5.7");
    expect(
      substitute("pre-migration/{fork_branch}", { fork_branch: "agentweave/v2026.5.7" }),
    ).toBe("pre-migration/agentweave/v2026.5.7");
  });
});
