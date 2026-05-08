import { execa } from "execa";

export type ProbeSpec = { name: string; cmd: string; parse: "json" | "exit"; optional: boolean };

export type ProbeFinding = {
  probe: string;
  level: "ok" | "warn" | "error";
  code: string;
  message: string;
};

export type ProbeResult = {
  classification: "GREEN" | "YELLOW" | "RED";
  findings: ProbeFinding[];
};

export async function runProbes(opts: {
  cwd: string;
  probes: ProbeSpec[];
}): Promise<ProbeResult> {
  const findings: ProbeFinding[] = [];
  for (const probe of opts.probes) {
    try {
      const { stdout } = await execa(probe.cmd, { cwd: opts.cwd, shell: true });
      if (probe.parse === "json") {
        const parsed = JSON.parse(stdout) as {
          findings?: Array<{ level: string; code: string; message: string }>;
        };
        if (parsed.findings && parsed.findings.length > 0) {
          for (const f of parsed.findings) {
            findings.push({
              probe: probe.name,
              level: (f.level as "ok" | "warn" | "error") ?? "warn",
              code: f.code,
              message: f.message,
            });
          }
        } else {
          findings.push({ probe: probe.name, level: "ok", code: "ok", message: "no findings" });
        }
      } else {
        findings.push({ probe: probe.name, level: "ok", code: "ok", message: "exit 0" });
      }
    } catch (err) {
      const e = err as { exitCode?: number; stderr?: string };
      const level = probe.optional ? "warn" : "error";
      findings.push({
        probe: probe.name,
        level,
        code: "probe.failed",
        message: `${probe.name} exited with code ${e.exitCode ?? "?"}: ${e.stderr ?? ""}`.trim(),
      });
    }
  }
  const hasError = findings.some((f) => f.level === "error");
  const hasWarn = findings.some((f) => f.level === "warn");
  return {
    classification: hasError ? "RED" : hasWarn ? "YELLOW" : "GREEN",
    findings,
  };
}
