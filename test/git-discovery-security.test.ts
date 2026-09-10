import assert from "node:assert/strict";

import { appendFile, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";

import { join } from "node:path";

import test, { type TestContext } from "node:test";

import { discoverCurrentWorktree } from "../src/host/git-discovery.ts";

import { validateBranchName } from "../src/host/branch.ts";

import { git, setupGit } from "./fixtures/git.ts";

const poisonEnvironment = (t: TestContext, changes: Record<string, string>): void => {
  for (const [key, value] of Object.entries(changes)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
};

test("a missing promisor object cannot trigger a lazy fetch or external remote helper", async (t) => {
  const { base, config } = await setupGit(t);
  const head = await git(config.repositoryPath, ["rev-parse", "HEAD"]);
  const marker = join(base, "FETCH_EXECUTED");
  const script = join(base, "remote-command");
  await writeFile(script, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  await appendFile(
    join(config.repositoryPath, ".git/config"),
    `
[remote "origin"]
url = ext::${script}
promisor = true
[protocol "ext"]
allow = always
`,
  );
  await rm(join(config.repositoryPath, ".git/objects", head.slice(0, 2), head.slice(2)));
  await assert.rejects(discoverCurrentWorktree(config, config.repositoryPath), /discovery failed/);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("discovery ignores inherited Git/PATH state and never invokes configured hooks, filters or pagers", async (t) => {
  const { base, config } = await setupGit(t);
  const marker = join(base, "EXECUTED");
  const script = join(base, "host-command");
  await writeFile(script, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  const shims = join(base, "shims");
  await mkdir(shims);
  await symlink(script, join(shims, "git"));
  const hooks = join(base, "hooks");
  await mkdir(hooks);
  await symlink(script, join(hooks, "post-checkout"));
  await symlink(script, join(hooks, "reference-transaction"));
  const included = join(base, "included.conf");
  await writeFile(included, `[core]\nworktree = ${base}\nfsmonitor = ${script}\npager = ${script}\n`);
  await appendFile(
    join(config.repositoryPath, ".git/config"),
    `
[include]
path = ${included}
[core]
hooksPath = ${hooks}
[alias]
worktree = !${script}
symbolic-ref = !${script}
rev-parse = !${script}
[filter "host-command"]
clean = ${script}
smudge = ${script}
process = ${script}
required = true
[pager]
worktree = true
symbolic-ref = true
rev-parse = true
`,
  );
  await writeFile(join(config.repositoryPath, ".gitattributes"), "* filter=host-command\n");
  poisonEnvironment(t, {
    PATH: shims,
    GIT_DIR: base,
    GIT_WORK_TREE: base,
    GIT_COMMON_DIR: base,
    GIT_CONFIG_GLOBAL: included,
    GIT_CONFIG_SYSTEM: included,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: base,
    GIT_NAMESPACE: "wrong",
    GIT_TRACE: marker,
    GIT_EXEC_PATH: shims,
    GIT_INDEX_FILE: marker,
    GIT_OBJECT_DIRECTORY: base,
  });
  const found = await discoverCurrentWorktree(config, config.repositoryPath);
  assert.equal(found.worktreePath, config.repositoryPath);
  assert.equal(found.branch, "main");
  await validateBranchName("feature/task"); // The older branch helper must not use poisoned PATH either.
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});
