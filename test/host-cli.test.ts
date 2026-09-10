import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { parseJson } from "../src/shared/validation.ts";
import { git, setupGit } from "./fixtures/git.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/host/cli.ts", import.meta.url));

test("inspect-only CLI emits current worktree data as terminal-safe JSON", async (t) => {
  const { config, configPath } = await setupGit(t);
  await git(config.repositoryPath, ["branch", "-m", "café/修正"]);
  const { stdout, stderr } = await exec(process.execPath, [cli, "inspect", "--config", configPath], {
    cwd: config.repositoryPath,
    timeout: 10000,
  });
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /[^\x00-\x7f]/);
  const result = z
    .object({ branch: z.string(), worktreePath: z.string(), head: z.string() })
    .parse(parseJson(stdout));
  assert.equal(result.branch, "café/修正");
  assert.equal(result.worktreePath, config.repositoryPath);
  assert.match(result.head, /^[a-f0-9]{40}$/);
});

test("CLI requires an explicit config and refuses unknown commands", async () => {
  for (const args of [
    [],
    ["inspect"],
    ["start"],
    ["recover"],
    ["exec", "id"],
    ["inspect", "--command", "id"],
  ]) {
    await assert.rejects(exec(process.execPath, [cli, ...args], { timeout: 10000 }), (error: unknown) => {
      const failure = z.object({ code: z.number(), stderr: z.string(), stdout: z.string() }).parse(error);
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, "");
      z.object({ error: z.string() }).parse(parseJson(failure.stderr));
      return true;
    });
  }
  const { stdout } = await exec(process.execPath, [cli, "--help"]);
  assert.match(stdout, /does not start Docker/);
});

test("start refuses a noninteractive terminal before contacting Docker", async (t) => {
  const { config, configPath } = await setupGit(t);
  await assert.rejects(
    exec(process.execPath, [cli, "start", "--config", configPath], {
      cwd: config.repositoryPath,
      timeout: 10000,
    }),
    /requires an interactive terminal/,
  );
});
