// Run after build; separate from source tests so stale dist cannot hide a failure.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { HelperReplySchema } from "../src/shared/helper.ts";
import { isRecord, parseJson } from "../src/shared/validation.ts";
import { git, setupGit } from "./fixtures/git.ts";

const exec = promisify(execFile);
const isCallable = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === "function";

test("compiled host CLI, Git worker and extension load without TypeScript source resolution", async (t) => {
  const { config, configPath } = await setupGit(t);
  const cli = fileURLToPath(new URL("../dist/host/cli.js", import.meta.url));
  const { stdout } = await exec(process.execPath, [cli, "inspect", "--config", configPath], {
    cwd: config.repositoryPath,
  });
  assert.equal(z.object({ branch: z.string() }).parse(parseJson(stdout)).branch, "main");
  const worker: unknown = await import(new URL("../dist/git/worker.js", import.meta.url).href);
  assert.ok(isRecord(worker) && isCallable(worker.helperMain));
  const runWorker = worker.helperMain;
  const helperMain = async (input: string) =>
    HelperReplySchema.parse(parseJson(z.string().parse(await runWorker(input))));
  const common = join(config.repositoryPath, ".git");
  const location = { worktreePath: config.repositoryPath, gitDir: common, commonGitDir: common };
  const inspected = await helperMain(JSON.stringify({ op: "inspect", location }));
  assert.equal(inspected.ok, true);
  assert.equal(inspected.state?.dirty, false);
  const destination = join(config.worktreeRoot, "compiled-task");
  await mkdir(destination);
  const created = await helperMain(
    JSON.stringify({
      op: "create",
      location,
      destination,
      branch: "compiled/task",
      source: { branch: "main", head: await git(config.repositoryPath, ["rev-parse", "HEAD"]) },
    }),
  );
  assert.equal(created.ok, true);
  assert.equal(
    await git(destination, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
    "refs/heads/main",
  );
  const module: unknown = await import(new URL("../dist/extension/index.js", import.meta.url).href);
  assert.ok(isRecord(module) && isCallable(module.default));
  const extension = module.default;
  const commands: string[] = [];
  const events: string[] = [];
  extension({
    registerCommand: (name: string) => commands.push(name),
    on: (event: string) => events.push(event),
  });
  assert.deepEqual(commands.sort(), [
    "worktree",
    "worktree-done",
    "worktree-merge",
    "worktree-sync",
    "worktrees",
  ]);
  assert.ok(events.includes("agent_settled") && !events.includes("agent_end"));
});
