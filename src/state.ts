import fs from "node:fs/promises";

export type Phase = "preflight" | "backup" | "branch" | "gates" | "cutover" | "probes" | "done";

export type State = {
  phase: Phase;
  tag: string;
  forkBranch: string;
  startedAt: number;
};

export async function writeState(path: string, state: Omit<State, "startedAt"> & { startedAt?: number }) {
  const merged: State = { startedAt: Date.now(), ...state, phase: state.phase };
  await fs.writeFile(path, JSON.stringify(merged, null, 2), "utf-8");
}

export async function readState(path: string): Promise<State | null> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return JSON.parse(raw) as State;
  } catch {
    return null;
  }
}
