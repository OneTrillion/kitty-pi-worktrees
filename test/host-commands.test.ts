import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveSelection, runHostCommand } from "../src/host/commands.ts";
import { acquireWorktreeLock } from "../src/host/lock.ts";
import { worktreeId } from "../src/host/paths.ts";
import { setupDocker } from "./fixtures/docker.ts";
import { git, setupGit } from "./fixtures/git.ts";

test("host selectors resolve live branches and ID prefixes, not paths or revisions; ambiguity is refused", async (t) => {
  const { config } = await setupGit(t);
  const id = worktreeId(config.repositoryPath);
  for (const selector of ["main", id, id.slice(0, 8)]) assert.equal(await resolveSelection(config, selector), id);
  for (const selector of [config.repositoryPath, "../repo", "main~0", "missing", id.slice(0, 7)]) {
    await assert.rejects(resolveSelection(config, selector), /Select one existing/);
  }
  const task = join(config.worktreeRoot, "task");
  await git(config.repositoryPath, ["worktree", "add", "-b", id.slice(0, 8), task]);
  await assert.rejects(resolveSelection(config, id.slice(0, 8)), /Select one existing/);
  await git(task, ["branch", "-m", "renamed"]);
  assert.equal(await resolveSelection(config, "renamed"), worktreeId(task));
  assert.equal(await resolveSelection(config, id.slice(0, 8)), id);
});

test("host list/open use isolated inspection, retain control dirs through replies and never refocus active worktrees", async (t) => {
  const f = await setupDocker(t);
  let launches = 0;
  let lock: Awaited<ReturnType<typeof acquireWorktreeLock>> | undefined;
  t.after(async () => { await lock?.release(); });
  const options = { dockerFactory: f.factory, service: { user: { uid: 1000, gid: 1000 },
    launch: async (path: string) => { launches++; lock = await acquireWorktreeLock(f.config.runtimeRoot, path); },
  } };
  const listed = await runHostCommand(f.config, f.configPath, "list", undefined, options);
  assert.ok(listed?.ok && listed.op === "list");
  assert.equal(listed.worktrees[0]?.inspection, "ok");
  const opened = await runHostCommand(f.config, f.configPath, "open", "main", options);
  assert.ok(opened?.ok && opened.op === "open" && opened.outcome === "reopened");
  const active = await runHostCommand(f.config, f.configPath, "open", "main", options);
  assert.ok(active?.ok && active.op === "open" && active.outcome === "already-active");
  assert.equal(launches, 1);
  await assert.rejects(runHostCommand(f.config, f.configPath, "open", "missing", options));
  assert.equal(await runHostCommand(f.config, f.configPath, "recover-git", undefined, options), null);
  assert.deepEqual(await f.state(), []);
  assert.ok((await readdir(f.config.runtimeRoot)).every((entry) => /^[a-f0-9]{64}\.lock$/.test(entry)));
});
