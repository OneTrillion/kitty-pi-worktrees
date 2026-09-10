import assert from "node:assert/strict";

import { appendFile, lstat, mkdir, writeFile } from "node:fs/promises";

import { join } from "node:path";

import test from "node:test";

import { classifyState } from "../src/shared/git-state.ts";

import { operations } from "./fixtures/git-operations.ts";
import { git, setupGit } from "./fixtures/git.ts";

test("status prioritizes conflicts and dirty files; equal heads count as merged", () => {
  const base = {
    dirty: false,
    conflicts: false,
    operation: null,
    upstream: null,
    containsUpstream: false,
    containedByUpstream: false,
  };
  assert.equal(classifyState(base), "clean");
  assert.equal(classifyState({ ...base, upstream: { exists: false } }), "upstream-gone");
  assert.equal(classifyState({ ...base, upstream: { exists: true } }), "needs-sync");
  assert.equal(classifyState({ ...base, upstream: { exists: true }, containsUpstream: true }), "ahead");
  assert.equal(
    classifyState({ ...base, upstream: { exists: true }, containsUpstream: true, containedByUpstream: true }),
    "merged",
  );
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
  assert.deepEqual((await task.state()).upstream, {
    ref: "refs/heads/feature/payments",
    kind: "local",
    exists: true,
  });
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
  await appendFile(
    join(config.repositoryPath, ".git/config"),
    `\n[filter "unsafe"]\nclean = ${script}\nsmudge = ${script}\nprocess = ${script}\nrequired = true\n`,
  );
  await writeFile(join(config.repositoryPath, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, {
    mode: 0o755,
  });
  const instance = await operations(config.repositoryPath);
  await instance.done();
  const path = join(config.worktreeRoot, "safe");
  await mkdir(path);
  await instance.createWorktree("safe", path, { branch: "main", head: await instance.commit() });
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});
