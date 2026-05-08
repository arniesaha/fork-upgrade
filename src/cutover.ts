import { execa } from "execa";

export type CutoverResult = { ok: boolean; verifyOutput: string; restartOutput: string };

export async function runCutover(opts: {
  cwd: string;
  restartCmd: string;
  verifyCmd: string;
}): Promise<CutoverResult> {
  const restart = await execa(opts.restartCmd, { cwd: opts.cwd, shell: true, stdio: "pipe" });
  try {
    const verify = await execa(opts.verifyCmd, { cwd: opts.cwd, shell: true, stdio: "pipe" });
    return { ok: true, restartOutput: restart.stdout, verifyOutput: verify.stdout };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return {
      ok: false,
      restartOutput: restart.stdout,
      verifyOutput: `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
    };
  }
}
