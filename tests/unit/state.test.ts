import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { writeState, readState } from "../../src/state.js";

describe("state", () => {
  it("round-trips phase markers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "state-"));
    const file = path.join(root, ".fork-upgrade-state.json");
    await writeState(file, { phase: "backup", tag: "v1", forkBranch: "fork/v1" });
    const back = await readState(file);
    expect(back?.phase).toBe("backup");
  });

  it("round-trips ladder fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "state-ladder-"));
    const file = path.join(dir, "state.json");
    await writeState(file, {
      phase: "gates",
      tag: "v3",
      forkBranch: "fork/v3",
      ladder: ["v2", "v3"],
      ladderIndex: 1,
      hopTag: "v3",
    });
    const s = await readState(file);
    expect(s?.ladder).toEqual(["v2", "v3"]);
    expect(s?.ladderIndex).toBe(1);
    expect(s?.hopTag).toBe("v3");
  });
});
