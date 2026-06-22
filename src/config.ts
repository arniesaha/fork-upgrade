import fs from "node:fs/promises";
import toml from "@iarna/toml";
import { z } from "zod";

const ProbeSchema = z.object({
  name: z.string(),
  cmd: z.string(),
  parse: z.enum(["json", "exit"]).default("exit"),
  optional: z.boolean().default(false),
});

const ConfigSchema = z.object({
  upstream: z.object({
    remote: z.string().default("upstream"),
    tag_pattern: z.string().default("v*"),
    fetch_before: z.boolean().default(true),
    prerelease_pattern: z.string().default("-(rc|alpha|beta|pre)"),
  }),
  fork: z.object({
    origin_remote: z.string().default("origin"),
    branch_pattern: z.string(),
  }),
  carry: z.object({
    manifest: z.string(),
  }),
  backup: z.object({
    anchor_tag: z.string(),
    push_anchor: z.boolean().default(true),
    config_files: z.array(z.string()).default([]),
    state_archive: z
      .object({ paths: z.array(z.string()), output: z.string() })
      .optional(),
  }),
  gates: z.object({
    install: z.string().optional(),
    typecheck: z.string().optional(),
    test: z.union([z.string(), z.array(z.string())]).optional(),
    build: z.string().optional(),
  }),
  cutover: z.object({
    restart: z.string(),
    verify: z.string(),
  }),
  probes: z
    .object({
      post_cutover: z.array(ProbeSchema).default([]),
    })
    .default({ post_cutover: [] }),
  rollback: z
    .object({ restart_after: z.boolean().default(true) })
    .default({ restart_after: true }),
});

export type ForkUpgradeConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(path: string): Promise<ForkUpgradeConfig> {
  const raw = await fs.readFile(path, "utf-8");
  const parsed = toml.parse(raw);
  return ConfigSchema.parse(parsed);
}

export function substitute(
  template: string,
  vars: { tag?: string; fork_branch?: string },
): string {
  return template
    .replace(/\{tag\}/g, vars.tag ?? "")
    .replace(/\{fork_branch\}/g, vars.fork_branch ?? "");
}
