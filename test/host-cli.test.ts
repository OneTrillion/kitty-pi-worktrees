import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git, setupGit } from "./fixtures/git.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/host/cli.ts", import.meta.url));

test("inspect-only CLI emits current worktree data as terminal-safe JSON", async (t) => {
  const { config, configPath } = await setupGit(t);
  await git(config.repositoryPath, ["branch", "-m", "café/修正"]);
  const { stdout, stderr } = await exec(process.execPath, [cli, "inspect", "--config", configPath], {
    cwd: config.repositoryPath, timeout: 10000,
  });
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /[^\x00-\x7f]/);
  const result = JSON.parse(stdout) as { branch: string; worktreePath: string; head: string };
  assert.equal(result.branch, "café/修正");
  assert.equal(result.worktreePath, config.repositoryPath);
  assert.match(result.head, /^[a-f0-9]{40}$/);
});

test("CLI requires an explicit config and refuses unimplemented/unknown commands", async () => {
  for (const args of [[], ["inspect"], ["start"], ["exec", "id"], ["inspect", "--command", "id"]]) {
    await assert.rejects(exec(process.execPath, [cli, ...args], { timeout: 10000 }), (error: unknown) => {
      const failure = error as { code: number; stderr: string; stdout: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, "");
      assert.equal(typeof (JSON.parse(failure.stderr) as { error: unknown }).error, "string");
      return true;
    });
  }
  const { stdout } = await exec(process.execPath, [cli, "--help"]);
  assert.match(stdout, /does not start Docker/);
});
