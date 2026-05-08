#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { loadConfig, substitute } from "./config.js";
import { resolveCarryList, ghPrStateFromCli } from "./carry-manifest.js";
import { runBackup } from "./backup.js";
import { branchAndCherryPick } from "./branch.js";
import { runGates } from "./gates.js";
import { runCutover } from "./cutover.js";
import { runProbes, type ProbeSpec } from "./probes.js";
import { runRollback } from "./rollback.js";
import { writeState } from "./state.js";
import { prompt } from "./checkpoint.js";

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      "config-path": { type: "string", default: ".fork-upgrade.toml" },
      "upstream-repo": { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.tag) throw new Error("--tag is required");
  if (!values["upstream-repo"]) throw new Error("--upstream-repo is required (e.g. openclaw/openclaw)");

  const cfg = await loadConfig(values["config-path"]!);
  const repoDir = process.cwd();
  const tag = values.tag!;
  const forkBranch = substitute(cfg.fork.branch_pattern, { tag });
  const stateFile = path.join(repoDir, ".fork-upgrade-state.json");

  await writeState(stateFile, { phase: "preflight", tag, forkBranch });
  const carry = await resolveCarryList({
    manifestPath: path.join(repoDir, cfg.carry.manifest),
    upstreamRepo: values["upstream-repo"]!,
    ghPrState: ghPrStateFromCli,
  });
  console.log(`carry kept: ${carry.kept.map((c) => c.sha).join(", ") || "(none)"}`);
  console.log(`carry landed-upstream (will skip): ${carry.landed.map((c) => c.sha).join(", ") || "(none)"}`);

  if (values["dry-run"]) return;

  await writeState(stateFile, { phase: "backup", tag, forkBranch });
  await runBackup({
    repoDir,
    anchorTag: substitute(cfg.backup.anchor_tag, { fork_branch: forkBranch, tag }),
    pushAnchor: cfg.backup.push_anchor,
    originRemote: cfg.fork.origin_remote,
    configFiles: cfg.backup.config_files,
    configSnapshotSuffix: `.pre-${tag}`,
    stateArchive: cfg.backup.state_archive
      ? {
          paths: cfg.backup.state_archive.paths,
          output: substitute(cfg.backup.state_archive.output, { tag }),
        }
      : undefined,
  });

  await writeState(stateFile, { phase: "branch", tag, forkBranch });
  await branchAndCherryPick({
    repoDir,
    newBranch: forkBranch,
    baseRef: tag,
    shas: carry.kept.map((c) => c.sha),
    onConflict: async (sha, files) => {
      const ans = await prompt({
        message: `cherry-pick of ${sha} conflicts in: ${files.join(", ")}\nResolve in your editor, then choose:`,
        options: ["proceed", "abort"],
        yes: false,
      });
      return ans === "proceed";
    },
  });

  await writeState(stateFile, { phase: "gates", tag, forkBranch });
  const gateCmds = [
    cfg.gates.install,
    cfg.gates.typecheck,
    ...(typeof cfg.gates.test === "string" ? [cfg.gates.test] : cfg.gates.test ?? []),
    cfg.gates.build,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  const gates = await runGates({ cwd: repoDir, commands: gateCmds });
  if (!gates.ok) {
    console.error(`gate failed: ${gates.failedCommand}\n${gates.tail}`);
    process.exit(2);
  }

  const ans1 = await prompt({
    message: "Gates passed. Push branch + run cutover restart?",
    options: ["proceed", "abort"],
    yes: values.yes,
  });
  if (ans1 !== "proceed") return;

  await writeState(stateFile, { phase: "cutover", tag, forkBranch });
  const cut = await runCutover({
    cwd: repoDir,
    restartCmd: cfg.cutover.restart,
    verifyCmd: cfg.cutover.verify,
  });
  if (!cut.ok) {
    console.error(`cutover verify failed:\n${cut.verifyOutput}`);
    process.exit(2);
  }

  await writeState(stateFile, { phase: "probes", tag, forkBranch });
  const probes: ProbeSpec[] = cfg.probes.post_cutover.map((p) => ({
    name: p.name,
    cmd: substitute(p.cmd, { tag, fork_branch: forkBranch }),
    parse: p.parse,
    optional: p.optional,
  }));
  const probeResult = await runProbes({ cwd: repoDir, probes });
  console.log(`probes: ${probeResult.classification}`);
  for (const f of probeResult.findings) {
    console.log(`  [${f.level}] ${f.probe}: ${f.code} — ${f.message}`);
  }
  if (probeResult.classification === "RED") {
    const rollAns = await prompt({
      message: "Probes RED. Roll back?",
      options: ["proceed", "abort"],
      yes: false,
    });
    if (rollAns === "proceed") {
      await runRollback({
        repoDir,
        anchorTag: substitute(cfg.backup.anchor_tag, { fork_branch: forkBranch, tag }),
        configRestores: cfg.backup.config_files.map((live) => ({
          live,
          snapshot: `${live}.pre-${tag}`,
        })),
      });
      if (cfg.rollback.restart_after) {
        await runCutover({ cwd: repoDir, restartCmd: cfg.cutover.restart, verifyCmd: cfg.cutover.verify });
      }
    }
  }
  await writeState(stateFile, { phase: "done", tag, forkBranch });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
