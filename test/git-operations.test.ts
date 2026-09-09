import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GitOperations } from "../src/git/operations.ts";
import { classifyState } from "../src/shared/git-state.ts";
import { git, setupGit } from "./fixtures/git.ts";

async function operations(path: string): Promise<GitOperations> {
  const instance = new GitOperations({ worktreePath: path,
    gitDir: await git(path, ["rev-parse", "--absolute-git-dir"]),
    commonGitDir: await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) });
  await instance.prepare();
  return instance;
}
async function commit(path: string, file: string, value: string) {
  await writeFile(join(path, file), value);
  await git(path, ["add", file]);
  await git(path, ["commit", "-m", file]);
}

test("status priority matches the plan, including equal heads being merged", () => {
  const base = { dirty: false, conflicts: false, operation: null, upstream: null, containsUpstream: false, containedByUpstream: false };
  assert.equal(classifyState(base), "clean");
  assert.equal(classifyState({ ...base, upstream: { exists: false } }), "upstream-gone");
  assert.equal(classifyState({ ...base, upstream: { exists: true } }), "needs-sync");
  assert.equal(classifyState({ ...base, upstream: { exists: true }, containsUpstream: true }), "ahead");
  assert.equal(classifyState({ ...base, upstream: { exists: true }, containsUpstream: true, containedByUpstream: true }), "merged");
  assert.equal(classifyState({ ...base, dirty: true, upstream: { exists: false } }), "dirty");
  assert.equal(classifyState({ ...base, dirty: true, operation: "rebase" }), "conflict");
});

test("create from a feature branch, nest tasks, and preserve existing branch upstreams", async (t) => {
  const { config } = await setupGit(t);
  await git(config.repositoryPath, ["branch", "feature/payments"]);
  const main = await operations(config.repositoryPath);
  const source = { branch: "feature/payments", head: await main.commit("refs/heads/feature/payments") };
  const taskPath = join(config.worktreeRoot, "task");
  await mkdir(taskPath);
  await main.createWorktree("task", taskPath, source);
  const task = await operations(taskPath);
  assert.deepEqual((await task.state()).upstream, { ref: "refs/heads/feature/payments", kind: "local", exists: true });
  const nested = join(config.worktreeRoot, "docs");
  await mkdir(nested);
  await main.createWorktree("docs", nested, { branch: "task", head: await task.commit() });
  assert.equal((await (await operations(nested)).state()).upstream?.ref, "refs/heads/task");
  await git(config.repositoryPath, ["branch", "--track", "existing", "main"]);
  const existing = join(config.worktreeRoot, "existing");
  await mkdir(existing);
  await main.createWorktree("existing", existing, source);
  assert.equal((await (await operations(existing)).state()).upstream?.ref, "refs/heads/main");
  const detached = join(config.worktreeRoot, "bad");
  await mkdir(detached);
  await assert.rejects(main.createWorktree("bad", detached, { branch: null, head: source.head }), /detached/);
  assert.equal(await main.branchExists("bad"), false);
});

test("done rejects modified, untracked, merge and rebase state and never creates commits", async (t) => {
  const { config } = await setupGit(t);
  const repo = config.repositoryPath;
  const instance = await operations(repo);
  const head = await instance.commit();
  assert.equal((await instance.done()).head, head);
  await writeFile(join(repo, "untracked"), "unfinished");
  await assert.rejects(instance.done(), /untracked/);
  assert.equal(await instance.commit(), head);
  await mkdir(join(repo, ".git/rebase-merge"));
  assert.equal((await instance.state()).status, "conflict");
  await assert.rejects(instance.done(), /merge\/rebase/);
});

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
  await assert.rejects(target.integrate("task", () => task.state()), /cannot fast-forward/);
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
  await assert.rejects(target.integrate("task", () => task.state()), /untracked/);
  await git(taskPath, ["add", "unfinished"]);
  await git(taskPath, ["commit", "-m", "task"]);
  await assert.rejects(target.integrate("task", async () => {
    const snapshot = await task.state();
    await commit(taskPath, "another", "advanced");
    return snapshot;
  }), /changed during inspection/);
  assert.equal(await target.commit(), targetHead);
  await git(config.repositoryPath, ["branch", "other-parent"]);
  await git(taskPath, ["branch", "--set-upstream-to=other-parent"]);
  await assert.rejects(target.integrate("task", () => task.state()), /upstream must/);
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
  assert.deepEqual(await task.upstream("task"), { kind: "remote", ref: "refs/remotes/origin/task", exists: true });
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

test("submodule and ambiguous callback configuration fail closed before project programs can run", async (t) => {
  const { config } = await setupGit(t);
  const repo = config.repositoryPath;
  const instance = await operations(repo);
  await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${await instance.commit()},submodule`]);
  await assert.rejects(instance.done(), /Submodule/);
  await appendFile(join(repo, ".git/config"), '\n[filter "a=b"]\nclean = false\n');
  await assert.rejects(instance.prepare(), /Unsupported executable Git config key/);
});

test("configured hooks and executable filters are not run by checks or worktree checkout", async (t) => {
  const { base, config } = await setupGit(t);
  const marker = join(base, "CALLED");
  const script = join(base, "callback");
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  await writeFile(join(config.repositoryPath, ".gitattributes"), "*.txt filter=unsafe\n");
  await git(config.repositoryPath, ["add", ".gitattributes"]);
  await git(config.repositoryPath, ["commit", "-m", "attributes"]);
  await appendFile(join(config.repositoryPath, ".git/config"), `\n[filter "unsafe"]\nclean = ${script}\nsmudge = ${script}\nprocess = ${script}\nrequired = true\n`);
  await writeFile(join(config.repositoryPath, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const instance = await operations(config.repositoryPath);
  await instance.done();
  const path = join(config.worktreeRoot, "safe");
  await mkdir(path);
  await instance.createWorktree("safe", path, { branch: "main", head: await instance.commit() });
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});
