#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { execa } from "execa";
import { loadConfig, substitute } from "./config.js";
import {
  resolveCarryList,
  ghPrStateFromCli,
  assertCarryShasExist,
  searchUpstreamForCarries,
  ghSearchFromCli,
} from "./carry-manifest.js";
import { runBackup } from "./backup.js";
import { branchAndCherryPick } from "./branch.js";
import { runGates } from "./gates.js";
import { runCutover } from "./cutover.js";
import { runProbes, type ProbeSpec } from "./probes.js";
import { runRollback } from "./rollback.js";
import { writeState, readState } from "./state.js";
import { prompt } from "./checkpoint.js";
import { verifyCarryIntegrity } from "./carry-integrity.js";
import { resolveLadder } from "./ladder.js";

type HopCtx = {
  repoDir: string;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  carry: Awaited<ReturnType<typeof resolveCarryList>>;
  stateFile: string;
  yes: boolean;
  target: string;
  ladder: string[];
  resume?: boolean;
};

async function runHop(ctx: HopCtx, hopTag: string, ladderIndex: number, final: boolean): Promise<boolean> {
  const { repoDir, cfg, carry, stateFile, yes, target, ladder } = ctx;
  const hopBranch = substitute(cfg.fork.branch_pattern, { tag: hopTag });
  const journalBase = { tag: target, forkBranch: hopBranch, ladder, ladderIndex, hopTag };

  await writeState(stateFile, { phase: "branch", ...journalBase });
  const branchResult = await branchAndCherryPick({
    repoDir,
    newBranch: hopBranch,
    baseRef: hopTag,
    shas: carry.kept.map((c) => c.sha),
    force: ctx.resume === true,
    onConflict: async (sha, files) => {
      const ans = await prompt({
        message: `cherry-pick of ${sha} conflicts in: ${files.join(", ")}\nResolve in your editor, then choose:`,
        options: ["proceed", "abort"],
        yes: false,
      });
      return ans === "proceed";
    },
  });

  const integrity = await verifyCarryIntegrity({ repoDir, carries: carry.kept, emptyPicks: branchResult.emptyPicks });
  if (integrity.length > 0) {
    console.log("carry-integrity warnings:");
    for (const f of integrity) console.log(`  [${f.kind}] ${f.sha} ${f.subject}: ${f.detail}`);
    await writeState(stateFile, {
      phase: "branch",
      ...journalBase,
      notes: integrity.map((f) => `${f.kind}:${f.sha}:${f.detail}`),
    });
    if (final) {
      const ans = await prompt({ message: "Carry-integrity warnings above. Proceed anyway?", options: ["proceed", "abort"], yes });
      if (ans !== "proceed") return false;
    }
  }

  await writeState(stateFile, { phase: "gates", ...journalBase });
  const gateCmds = [
    cfg.gates.install,
    cfg.gates.typecheck,
    ...(typeof cfg.gates.test === "string" ? [cfg.gates.test] : cfg.gates.test ?? []),
    cfg.gates.build,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  const gates = await runGates({ cwd: repoDir, commands: gateCmds });
  if (!gates.ok) {
    console.error(`gate failed at hop ${hopTag}: ${gates.failedCommand}\n${gates.tail}`);
    process.exit(2);
  }

  if (!final) {
    // Intermediate validation hop passed: discard the throwaway branch and move on.
    // Detach to the upstream tag first so the branch we're on can be deleted.
    await execa("git", ["checkout", hopTag], { cwd: repoDir });
    await execa("git", ["branch", "-D", hopBranch], { cwd: repoDir });
    return true;
  }

  const ans1 = await prompt({ message: "Gates passed. Push branch + run cutover restart?", options: ["proceed", "abort"], yes });
  if (ans1 !== "proceed") return false;

  await writeState(stateFile, { phase: "cutover", ...journalBase });
  const cut = await runCutover({ cwd: repoDir, restartCmd: cfg.cutover.restart, verifyCmd: cfg.cutover.verify });
  if (!cut.ok) {
    console.error(`cutover verify failed:\n${cut.verifyOutput}`);
    process.exit(2);
  }

  await writeState(stateFile, { phase: "probes", ...journalBase });
  const probes: ProbeSpec[] = cfg.probes.post_cutover.map((p) => ({
    name: p.name,
    cmd: substitute(p.cmd, { tag: hopTag, fork_branch: hopBranch }),
    parse: p.parse,
    optional: p.optional,
  }));
  const probeResult = await runProbes({ cwd: repoDir, probes });
  console.log(`probes: ${probeResult.classification}`);
  for (const f of probeResult.findings) console.log(`  [${f.level}] ${f.probe}: ${f.code} — ${f.message}`);
  if (probeResult.classification === "RED") {
    const rollAns = await prompt({ message: "Probes RED. Roll back?", options: ["proceed", "abort"], yes: false });
    if (rollAns === "proceed") {
      await runRollback({
        repoDir,
        anchorTag: substitute(cfg.backup.anchor_tag, { fork_branch: substitute(cfg.fork.branch_pattern, { tag: target }), tag: target }),
        configRestores: cfg.backup.config_files.map((live) => ({ live, snapshot: `${live}.pre-${target}` })),
      });
      if (cfg.rollback.restart_after) {
        await runCutover({ cwd: repoDir, restartCmd: cfg.cutover.restart, verifyCmd: cfg.cutover.verify });
      }
    }
  }
  return true;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      "config-path": { type: "string", default: ".fork-upgrade.toml" },
      "upstream-repo": { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "from-tag": { type: "string" },
      "single-tag": { type: "boolean", default: false },
      "ladder-stop-at": { type: "string" },
      resume: { type: "boolean", default: false },
    },
  });
  if (!values.resume && !values.tag) throw new Error("--tag is required");
  if (!values["upstream-repo"]) throw new Error("--upstream-repo is required (e.g. openclaw/openclaw)");

  const cfg = await loadConfig(values["config-path"]!);
  const repoDir = process.cwd();
  const stateFile = path.join(repoDir, ".fork-upgrade-state.json");

  if (values.resume) {
    const prior = await readState(stateFile);
    if (!prior) {
      console.error(`--resume: no journal found at ${stateFile}`);
      process.exit(2);
    }
    const resumeTarget = prior.tag;
    const resumeLadder = prior.ladder ?? [resumeTarget];
    const resumeIndex = prior.ladderIndex ?? 0;
    const resumeHopTag = prior.hopTag ?? resumeTarget;
    const expectedBranch = substitute(cfg.fork.branch_pattern, { tag: resumeHopTag });
    // Divergence refusal: dirty tree or HEAD not on the journaled hop branch.
    const { stdout: porcelain } = await execa("git", ["status", "--porcelain"], { cwd: repoDir });
    const { stdout: head } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir });
    // Only treat staged or modified tracked files as dirty (not untracked "??" files)
    const dirty = porcelain.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("??")).join("\n");
    if (dirty.trim() !== "") {
      console.error("refusing to resume: working tree has uncommitted changes");
      process.exit(2);
    }
    if (head.trim() !== expectedBranch) {
      console.error(`refusing to resume: HEAD is on '${head.trim()}', expected the journaled hop branch '${expectedBranch}'`);
      process.exit(2);
    }
    const carry = await resolveCarryList({
      manifestPath: path.join(repoDir, cfg.carry.manifest),
      upstreamRepo: values["upstream-repo"]!,
      ghPrState: ghPrStateFromCli,
    });
    console.log(`resuming from hop ${resumeHopTag} (phase ${prior.phase}, ladder ${resumeLadder.join(" -> ")})`);
    const ctx: HopCtx = { repoDir, cfg, carry, stateFile, yes: values.yes, target: resumeTarget, ladder: resumeLadder, resume: true };
    for (let i = resumeIndex; i < resumeLadder.length; i++) {
      const proceed = await runHop(ctx, resumeLadder[i], i, i === resumeLadder.length - 1);
      if (!proceed) return;
    }
    await writeState(stateFile, { phase: "done", tag: resumeTarget, forkBranch: expectedBranch });
    return;
  }

  const target = values.tag!;
  const forkBranch = substitute(cfg.fork.branch_pattern, { tag: target });

  await writeState(stateFile, { phase: "preflight", tag: target, forkBranch });
  const carry = await resolveCarryList({
    manifestPath: path.join(repoDir, cfg.carry.manifest),
    upstreamRepo: values["upstream-repo"]!,
    ghPrState: ghPrStateFromCli,
  });
  console.log(`carry kept: ${carry.kept.map((c) => c.sha).join(", ") || "(none)"}`);
  console.log(`carry landed-upstream (will skip): ${carry.landed.map((c) => c.sha).join(", ") || "(none)"}`);
  console.log(`carry parked (disabled): ${carry.parked.map((c) => c.sha).join(", ") || "(none)"}`);

  const shaCheck = await assertCarryShasExist({ repoDir, entries: carry.kept });
  if (!shaCheck.ok) {
    console.error("preflight: these carry SHAs do not resolve to commits:");
    for (const m of shaCheck.missing) console.error(`  ${m.sha} — ${m.subject}`);
    console.error(`Refresh the SHAs in ${cfg.carry.manifest} (git log) before running.`);
    process.exit(2);
  }

  const advisories = await searchUpstreamForCarries({
    entries: carry.kept,
    upstreamRepo: values["upstream-repo"]!,
    ghSearch: ghSearchFromCli,
  });
  for (const a of advisories) {
    console.log(
      `advisory: carry ${a.entry.sha} "${a.entry.subject}" may have landed upstream — ` +
        `${a.hits.length} match(es): ${a.hits.map((h) => h.url).join(", ")}`,
    );
  }

  let ladder: string[];
  if (values["single-tag"]) {
    ladder = [target];
  } else {
    try {
      const resolved = await resolveLadder({
        repoDir,
        tagPattern: cfg.upstream.tag_pattern,
        prereleasePattern: cfg.upstream.prerelease_pattern,
        fromTag: values["from-tag"],
        target,
      });
      ladder = resolved.ladder;
    } catch (err) {
      console.error(`ladder resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  if (values["ladder-stop-at"]) {
    const stop = ladder.indexOf(values["ladder-stop-at"]);
    if (stop === -1) {
      console.error(`--ladder-stop-at '${values["ladder-stop-at"]}' is not in the ladder: ${ladder.join(", ")}`);
      process.exit(2);
    }
    ladder = ladder.slice(0, stop + 1);
  }
  if (ladder.length > 1 && !cfg.fork.branch_pattern.includes("{tag}")) {
    console.error("multi-hop ladder requires '{tag}' in [fork].branch_pattern so each hop gets a distinct branch; add {tag} or pass --single-tag");
    process.exit(2);
  }
  console.log(`tag ladder: ${ladder.join(" -> ")}`);

  if (values["dry-run"]) return;

  await writeState(stateFile, { phase: "backup", tag: target, forkBranch });
  await runBackup({
    repoDir,
    anchorTag: substitute(cfg.backup.anchor_tag, { fork_branch: forkBranch, tag: target }),
    pushAnchor: cfg.backup.push_anchor,
    originRemote: cfg.fork.origin_remote,
    configFiles: cfg.backup.config_files,
    configSnapshotSuffix: `.pre-${target}`,
    stateArchive: cfg.backup.state_archive
      ? { paths: cfg.backup.state_archive.paths, output: substitute(cfg.backup.state_archive.output, { tag: target }) }
      : undefined,
  });

  const ctx: HopCtx = { repoDir, cfg, carry, stateFile, yes: values.yes, target, ladder };
  for (let i = 0; i < ladder.length; i++) {
    const proceed = await runHop(ctx, ladder[i], i, i === ladder.length - 1);
    if (!proceed) return;
  }

  await writeState(stateFile, { phase: "done", tag: target, forkBranch });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
