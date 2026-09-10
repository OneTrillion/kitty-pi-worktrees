import assert from "node:assert/strict";

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { join } from "node:path";

import test from "node:test";

import { commit, operations } from "./fixtures/git-operations.ts";
import { git, setupGit } from "./fixtures/git.ts";

test("sync preserves task conflicts; resolution allows target fast-forward and merged detection", async (t) => {
  const { config } = await setupGit(t);
  const repo = config.repositoryPath;
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  const target = await operations(repo);
  const taskPath = join(config.worktreeRoot, "task");
  await mkdir(taskPath);
  await target.createWorktree("task", taskPath, { branch: "main", head: await target.commit() });
  const task = await operations(taskPath);
  await commit(taskPath, "file.txt", "task change\n");
  assert.equal((await task.state()).status, "ahead");
  await commit(repo, "file.txt", "target change\n");
  const targetHead = await target.commit();
  assert.equal((await task.state()).status, "needs-sync");
  await assert.rejects(
    target.integrate("task", () => task.state()),
    /cannot fast-forward/,
  );
  assert.equal(await target.commit(), targetHead);
  const synced = await task.sync();
  assert.equal(synced.conflict, true);
  assert.equal(synced.state.status, "conflict");
  assert.equal(await target.commit(), targetHead);
  assert.equal((await target.state()).dirty, false);
  assert.match(await readFile(join(taskPath, "file.txt"), "utf8"), /<<<<<<<|>>>>>>>/);
  await commit(taskPath, "file.txt", "resolved\n");
  await target.integrate("task", () => task.state());
  assert.equal(await target.commit(), await task.commit());
  assert.equal((await task.state()).status, "merged");
});

test("missing/deleted/remote upstreams stop sync/integration rather than guessing", async (t) => {
  const { config } = await setupGit(t);
  const repo = config.repositoryPath;
  const instance = await operations(repo);
  await assert.rejects(instance.sync(), /LOCAL upstream/);
  await git(repo, ["branch", "parent"]);
  await git(repo, ["branch", "--set-upstream-to=parent", "main"]);
  await git(repo, ["branch", "-D", "parent"]); // Fixture only; production never deletes branches.
  assert.equal((await instance.state()).status, "upstream-gone");
  await assert.rejects(instance.sync(), /LOCAL upstream/);
  await git(repo, ["config", "branch.main.remote", "origin"]);
  await git(repo, ["config", "branch.main.merge", "refs/heads/main"]);
  assert.equal((await instance.state()).upstream?.kind, "remote");
  await assert.rejects(instance.sync(), /LOCAL upstream/);
});

test("integration rejects a dirty task, wrong parent and commits changed after host inspection", async (t) => {
  const { config } = await setupGit(t);
  const target = await operations(config.repositoryPath);
  const taskPath = join(config.worktreeRoot, "task");
  await mkdir(taskPath);
  await target.createWorktree("task", taskPath, { branch: "main", head: await target.commit() });
  const task = await operations(taskPath);
  await writeFile(join(taskPath, "unfinished"), "dirty");
  const targetHead = await target.commit();
  await assert.rejects(
    target.integrate("task", () => task.state()),
    /untracked/,
  );
  await git(taskPath, ["add", "unfinished"]);
  await git(taskPath, ["commit", "-m", "task"]);
  await assert.rejects(
    target.integrate("task", async () => {
      const snapshot = await task.state();
      await commit(taskPath, "another", "advanced");
      return snapshot;
    }),
    /changed during inspection/,
  );
  assert.equal(await target.commit(), targetHead);
  await git(config.repositoryPath, ["branch", "other-parent"]);
  await git(taskPath, ["branch", "--set-upstream-to=other-parent"]);
  await assert.rejects(
    target.integrate("task", () => task.state()),
    /upstream must/,
  );
});

test("clean sync can fast-forward and remote-upstream replacement is never treated as a local parent", async (t) => {
  const { config } = await setupGit(t);
  const repo = config.repositoryPath;
  const target = await operations(repo);
  const taskPath = join(config.worktreeRoot, "task");
  await mkdir(taskPath);
  await target.createWorktree("task", taskPath, { branch: "main", head: await target.commit() });
  const task = await operations(taskPath);
  await commit(repo, "target-only", "advanced\n");
  assert.equal((await task.sync()).conflict, false);
  assert.equal(await task.commit(), await target.commit());
  await git(repo, ["branch", "-m", "main", "renamed"]);
  const configured = await git(repo, ["config", "--get", "branch.task.merge"]);
  assert.equal((await task.upstream("task"))?.ref, configured);
  await git(repo, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await git(repo, ["update-ref", "refs/remotes/origin/task", await task.commit()]);
  await git(repo, ["config", "branch.task.remote", "origin"]);
  await git(repo, ["config", "branch.task.merge", "refs/heads/task"]);
  assert.deepEqual(await task.upstream("task"), {
    kind: "remote",
    ref: "refs/remotes/origin/task",
    exists: true,
  });
  await assert.rejects(task.sync(), /LOCAL upstream/);
});

test("revision-like or ambiguous upstream config is rejected, not evaluated as a parent branch", async (t) => {
  const { config } = await setupGit(t);
  const repo = config.repositoryPath;
  const instance = await operations(repo);
  await git(repo, ["config", "branch.main.remote", "."]);
  await git(repo, ["config", "branch.main.merge", "refs/heads/main~0"]);
  assert.equal((await instance.upstream("main"))?.exists, false);
  await assert.rejects(instance.sync(), /LOCAL upstream/);
  await git(repo, ["config", "branch.main.merge", "refs/heads/main"]);
  await git(repo, ["config", "--add", "branch.main.merge", "refs/heads/other"]);
  assert.equal((await instance.upstream("main"))?.exists, false);
});
