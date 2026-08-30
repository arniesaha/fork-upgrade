import { access, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runGates } from "../../src/gates.js";

describe("runGates", () => {
  let testTmp: string;

  beforeEach(async () => {
    testTmp = await mkdtemp(join(tmpdir(), "gates-test-"));
  });

  afterEach(async () => {
    await rm(testTmp, { recursive: true, force: true });
  });

  it("runs commands sequentially and returns success when all pass", async () => {
    const result = await runGates({ cwd: process.cwd(), commands: ["true", "true"] });
    expect(result.ok).toBe(true);
  });

  it("stops at the first failure and reports tail", async () => {
    const result = await runGates({
      cwd: process.cwd(),
      commands: ["true", "node -e \"console.error('boom'); process.exit(2)\"", "true"],
    });
    expect(result.ok).toBe(false);
    expect(result.failedCommand).toContain("process.exit(2)");
    expect(result.tail).toContain("boom");
  });

  it("same runGates invocation sees identical cache path in every command", async () => {
    const marker1 = join(testTmp, "cache1");
    const marker2 = join(testTmp, "cache2");
    const result = await runGates({
      cwd: process.cwd(),
      commands: [
        `sh -c 'printf "%s" "$OPENCLAW_VITEST_FS_MODULE_CACHE_PATH" > "${marker1}"'`,
        `sh -c 'printf "%s" "$OPENCLAW_VITEST_FS_MODULE_CACHE_PATH" > "${marker2}"'`,
      ],
    });
    expect(result.ok).toBe(true);
    const path1 = (await readFile(marker1, "utf-8")).trim();
    const path2 = (await readFile(marker2, "utf-8")).trim();
    expect(path1).toBeTruthy();
    expect(path1).toBe(path2);
  });

  it("propagates isolated cache env to child commands", async () => {
    const result = await runGates({
      cwd: process.cwd(),
      commands: ["sh -c 'echo $OPENCLAW_VITEST_FS_MODULE_CACHE_PATH; exit 1'"],
    });
    expect(result.ok).toBe(false);
    const cachePath = result.tail.trim();
    expect(cachePath).toContain(tmpdir());
    expect(cachePath).toContain("fork-upgrade-gates-");
    expect(cachePath).toContain("vitest-fs-module-cache");
  });

  it("each invocation gets a unique cache root", async () => {
    const a = await runGates({
      cwd: process.cwd(),
      commands: ["sh -c 'echo $OPENCLAW_VITEST_FS_MODULE_CACHE_PATH; exit 1'"],
    });
    const b = await runGates({
      cwd: process.cwd(),
      commands: ["sh -c 'echo $OPENCLAW_VITEST_FS_MODULE_CACHE_PATH; exit 1'"],
    });
    const pathA = a.ok ? "" : a.tail.trim();
    const pathB = b.ok ? "" : b.tail.trim();
    expect(pathA).not.toBe(pathB);
  });

  it("cleans up the cache root after failure", async () => {
    const result = await runGates({
      cwd: process.cwd(),
      commands: ["sh -c 'echo $OPENCLAW_VITEST_FS_MODULE_CACHE_PATH; exit 1'"],
    });
    const cachePath = result.ok ? "" : result.tail.trim();
    expect(cachePath).toBeTruthy();
    // Parent directory is mkdtemp's result; the printed value is the subdirectory.
    const parentDir = cachePath.split("vitest-fs-module-cache").at(0);
    await expect(access(parentDir!)).rejects.toThrow();
  });

  it("cleans up the cache root after success", async () => {
    const marker = join(testTmp, "success-marker");
    try {
      const result = await runGates({
        cwd: process.cwd(),
        commands: [
          `sh -c 'printf "%s" "$OPENCLAW_VITEST_FS_MODULE_CACHE_PATH" > "${marker}"'`,
          "true",
        ],
      });
      expect(result.ok).toBe(true);
      const loggedPath = (await readFile(marker, "utf-8")).trim();
      const parentDir = loggedPath.split("vitest-fs-module-cache").at(0);
      await expect(access(parentDir!)).rejects.toThrow();
    } finally {
      await rm(marker, { force: true });
    }
  });
});
