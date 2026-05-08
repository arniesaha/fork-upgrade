import { describe, expect, it } from "vitest";
import { runProbes } from "../../src/probes.js";

describe("runProbes", () => {
  it("classifies probes by exit code and JSON output", async () => {
    const result = await runProbes({
      cwd: process.cwd(),
      probes: [
        { name: "exit-ok", cmd: "true", parse: "exit", optional: false },
        {
          name: "json-error",
          cmd: 'node -e \'console.log(JSON.stringify({findings: [{level: "error", code: "x", message: "y"}]}))\'',
          parse: "json",
          optional: false,
        },
        { name: "exit-fail", cmd: "false", parse: "exit", optional: true },
      ],
    });
    expect(result.classification).toBe("RED");
    const namesByLevel = (lvl: string) =>
      result.findings.filter((f) => f.level === lvl).map((f) => f.probe);
    expect(namesByLevel("error")).toContain("json-error");
    expect(namesByLevel("warn")).toContain("exit-fail");
    expect(result.findings.find((f) => f.probe === "exit-ok")?.level).toBe("ok");
  });
});
