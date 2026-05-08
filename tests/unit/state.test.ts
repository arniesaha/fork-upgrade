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
});
