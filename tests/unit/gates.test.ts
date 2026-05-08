import { describe, expect, it } from "vitest";
import { runGates } from "../../src/gates.js";

describe("runGates", () => {
  it("runs commands sequentially and returns success when all pass", async () => {
    const result = await runGates({ cwd: process.cwd(), commands: ["true", "true"] });
    expect(result.ok).toBe(true);
  });

  it("stops at the first failure and reports tail", async () => {
    const result = await runGates({
      cwd: process.cwd(),
      commands: ["true", "node -e \"console.error('boom'); process.exit(2)\"", "true"],
    });
    expect(result.ok).toBe(false);
    expect(result.failedCommand).toContain("process.exit(2)");
    expect(result.tail).toContain("boom");
  });
});
