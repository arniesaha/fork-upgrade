import { execa } from "execa";

export type GatesResult =
  | { ok: true; ranCommands: string[] }
  | { ok: false; ranCommands: string[]; failedCommand: string; tail: string };

export async function runGates(opts: {
  cwd: string;
  commands: string[];
}): Promise<GatesResult> {
  const ran: string[] = [];
  for (const cmd of opts.commands) {
    try {
      await execa(cmd, { cwd: opts.cwd, shell: true, stdio: "pipe" });
      ran.push(cmd);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      const tail = `${e.stdout ?? ""}\n${e.stderr ?? ""}`
        .split("\n")
        .slice(-50)
        .join("\n");
      return { ok: false, ranCommands: ran, failedCommand: cmd, tail };
    }
  }
  return { ok: true, ranCommands: ran };
}
