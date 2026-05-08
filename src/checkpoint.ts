import readline from "node:readline/promises";

export type CheckpointAnswer = "proceed" | "skip" | "abort";

export async function prompt(opts: {
  message: string;
  options: CheckpointAnswer[];
  yes?: boolean;
}): Promise<CheckpointAnswer> {
  if (opts.yes) return "proceed";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(`${opts.message}\nOptions: ${opts.options.join(" / ")}\n> `)
    )
      .trim()
      .toLowerCase();
    if ((opts.options as string[]).includes(answer)) {
      return answer as CheckpointAnswer;
    }
    return "abort";
  } finally {
    rl.close();
  }
}
