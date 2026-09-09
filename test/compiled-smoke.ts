// Run after build; separate from source tests so stale dist cannot hide a failure.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, setupGit } from "./fixtures/git.ts";

const exec = promisify(execFile);
test("compiled host CLI, Git worker and extension load without TypeScript source resolution", async (t) => {
  const { config, configPath } = await setupGit(t);
  const cli = fileURLToPath(new URL("../dist/host/cli.js", import.meta.url));
  const { stdout } = await exec(process.execPath, [cli, "inspect", "--config", configPath], { cwd: config.repositoryPath });
  assert.equal(JSON.parse(stdout).branch, "main");
  const { helperMain } = await import(new URL("../dist/git/worker.js", import.meta.url).href);
  const common = join(config.repositoryPath, ".git");
  const location = { worktreePath: config.repositoryPath, gitDir: common, commonGitDir: common };
  const inspected = JSON.parse(await helperMain(JSON.stringify({ op: "inspect", location })));
  assert.equal(inspected.ok, true);
  assert.equal(inspected.state.dirty, false);
  const destination = join(config.worktreeRoot, "compiled-task");
  await mkdir(destination);
  const created = JSON.parse(await helperMain(JSON.stringify({ op: "create", location, destination, branch: "compiled/task",
    source: { branch: "main", head: await git(config.repositoryPath, ["rev-parse", "HEAD"]) } })));
  assert.equal(created.ok, true);
  assert.equal(await git(destination, ["rev-parse", "--symbolic-full-name", "@{upstream}"]), "refs/heads/main");
  const extension = (await import(new URL("../dist/extension/index.js", import.meta.url).href)).default;
  const commands: string[] = [];
  const events: string[] = [];
  extension({ registerCommand: (name: string) => commands.push(name), on: (event: string) => events.push(event) });
  assert.deepEqual(commands.sort(), ["worktree", "worktree-done", "worktree-merge", "worktree-sync", "worktrees"]);
  assert.ok(events.includes("agent_settled") && !events.includes("agent_end"));
});
