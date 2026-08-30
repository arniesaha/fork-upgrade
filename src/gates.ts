import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GatesResult =
  | { ok: true; ranCommands: string[] }
  | { ok: false; ranCommands: string[]; failedCommand: string; tail: string };

export async function runGates(opts: {
  cwd: string;
  commands: string[];
}): Promise<GatesResult> {
  const cacheRoot = await mkdtemp(join(tmpdir(), "fork-upgrade-gates-"));
  try {
    const gateEnv: Record<string, string> = {
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: join(cacheRoot, "vitest-fs-module-cache"),
    };
    const ran: string[] = [];
    for (const cmd of opts.commands) {
      try {
        await execa(cmd, { cwd: opts.cwd, shell: true, stdio: "pipe", env: gateEnv });
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
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}
