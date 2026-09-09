import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { discoverCurrentWorktree, parseWorktreePaths } from "../src/host/git-discovery.ts";
import { validateBranchName } from "../src/host/branch.ts";
import { git, setupGit } from "./fixtures/git.ts";

function poisonEnvironment(t: TestContext, changes: Record<string, string>): void {
  for (const [key, value] of Object.entries(changes)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test("discover a main worktree from a subdirectory or symlink cwd without modifying it", async (t) => {
  const { base, config } = await setupGit(t);
  const subdir = join(config.repositoryPath, "src");
  await mkdir(subdir);
  const alias = join(base, "cwd-alias");
  await symlink(subdir, alias);
  const expected = await git(config.repositoryPath, ["rev-parse", "HEAD"]);
  const index = await readFile(join(config.repositoryPath, ".git/index"));
  const configBefore = await readFile(join(config.repositoryPath, ".git/config"));
  await writeFile(join(config.repositoryPath, "file.txt"), "dirty changes survive\n");
  await writeFile(join(subdir, "untracked.txt"), "untracked changes survive\n");
  const found = await discoverCurrentWorktree(config, alias);
  assert.deepEqual(found, {
    worktreePath: config.repositoryPath, gitDir: join(config.repositoryPath, ".git"),
    commonGitDir: join(config.repositoryPath, ".git"), branch: "main", head: expected,
  });
  assert.deepEqual(await readFile(join(config.repositoryPath, ".git/index")), index);
  assert.deepEqual(await readFile(join(config.repositoryPath, ".git/config")), configBefore);
  assert.equal(await readFile(join(config.repositoryPath, "file.txt"), "utf8"), "dirty changes survive\n");
  assert.equal(await readFile(join(subdir, "untracked.txt"), "utf8"), "untracked changes survive\n");
});

test("discover a linked feature task with spaces/Unicode in its path and a local parent branch", async (t) => {
  const { config } = await setupGit(t);
  await git(config.repositoryPath, ["branch", "feature/payments"]);
  const task = join(config.worktreeRoot, "task café");
  await git(config.repositoryPath, ["worktree", "add", "-b", "feature/task", task, "feature/payments"]);
  await git(config.repositoryPath, ["branch", "--set-upstream-to=feature/payments", "feature/task"]);
  const result = await discoverCurrentWorktree(config, task);
  assert.equal(result.worktreePath, task);
  assert.equal(result.branch, "feature/task");
  assert.equal(result.commonGitDir, join(config.repositoryPath, ".git"));
  assert.ok(result.gitDir.startsWith(join(result.commonGitDir, "worktrees") + "/"));
  assert.equal(result.head, await git(task, ["rev-parse", "HEAD"]));
  assert.equal(await git(task, ["rev-parse", "--symbolic-full-name", "@{upstream}"]), "refs/heads/feature/payments");
});

test("detached worktrees can be discovered; creation policy will reject detached sources later", async (t) => {
  const { config } = await setupGit(t);
  const task = join(config.worktreeRoot, "detached");
  await git(config.repositoryPath, ["worktree", "add", "--detach", task, "main"]);
  const result = await discoverCurrentWorktree(config, task);
  assert.equal(result.branch, null);
  assert.equal(result.head, await git(task, ["rev-parse", "HEAD"]));
});

test("SHA-256 Git repositories are supported by discovery", async (t) => {
  const { config } = await setupGit(t, "sha256");
  assert.match((await discoverCurrentWorktree(config, config.repositoryPath)).head, /^[a-f0-9]{64}$/);
});

test("Git-valid existing branch names are not restricted to the request-name policy", async (t) => {
  const { config } = await setupGit(t);
  await git(config.repositoryPath, ["branch", "-m", "fix!existing"]);
  assert.equal((await discoverCurrentWorktree(config, config.repositoryPath)).branch, "fix!existing");
});

test("NUL worktree porcelain is parsed without unquoting or newline splitting", () => {
  assert.deepEqual(parseWorktreePaths("worktree /a b\0HEAD abc\0branch refs/heads/main\0\0worktree /a\nb\0detached\0\0"), ["/a b", "/a\nb"]);
  for (const output of ["", "worktree /a\n\n", "HEAD abc\0\0", "worktree relative\0\0", "worktree /a\0\0worktree /a\0\0"]) {
    assert.throws(() => parseWorktreePaths(output));
  }
});

test("outside, unregistered, nested and Git-metadata directories are refused", async (t) => {
  const { base, config } = await setupGit(t);
  await assert.rejects(discoverCurrentWorktree(config, base), /authorized/);
  await assert.rejects(discoverCurrentWorktree(config, config.worktreeRoot), /not a linked/);
  await assert.rejects(discoverCurrentWorktree(config, join(config.repositoryPath, ".git")), /authorized/);
  const independent = join(config.worktreeRoot, "independent");
  await mkdir(independent);
  await git(independent, ["init", "-b", "main"]);
  await assert.rejects(discoverCurrentWorktree(config, independent), /not a linked/);
  const nested = join(config.repositoryPath, "nested");
  await mkdir(nested);
  await git(nested, ["init", "-b", "main"]);
  await assert.rejects(discoverCurrentWorktree(config, nested), /nested Git repository/);
});

test("Git-listed worktrees outside the configured task root are not authorized", async (t) => {
  const { base, config } = await setupGit(t);
  const outside = join(base, "outside-task");
  await git(config.repositoryPath, ["worktree", "add", "-b", "outside", outside]);
  await assert.rejects(discoverCurrentWorktree(config, outside), /authorized/);
  assert.equal((await discoverCurrentWorktree(config, config.repositoryPath)).branch, "main");
});

test("a forged .git pointer cannot select arbitrary host Git directories", async (t) => {
  const { base, config } = await setupGit(t);
  const task = join(config.worktreeRoot, "task");
  await git(config.repositoryPath, ["worktree", "add", "-b", "task", task]);
  const before = await readFile(join(task, ".git"), "utf8");
  const hostile = `gitdir: ${join(base, "not-authorized")}\n`;
  await writeFile(join(task, ".git"), hostile);
  await assert.rejects(discoverCurrentWorktree(config, task), /this repository/);
  assert.equal(await readFile(join(task, ".git"), "utf8"), hostile); // No forced repair.
  await writeFile(join(task, ".git"), before);
  const found = await discoverCurrentWorktree(config, task);
  await writeFile(join(found.gitDir, "commondir"), `${base}\n`);
  await assert.rejects(discoverCurrentWorktree(config, task), /pointers disagree|discovery failed/);
});

test("symlinked .git files/admin directories and changed main Git anchors fail closed", async (t) => {
  const { base, config } = await setupGit(t);
  const task = join(config.worktreeRoot, "task");
  await git(config.repositoryPath, ["worktree", "add", "-b", "task", task]);
  const original = await readFile(join(task, ".git"), "utf8");
  const aliasTarget = join(base, "git-pointer");
  await writeFile(aliasTarget, original);
  await rm(join(task, ".git"));
  await symlink(aliasTarget, join(task, ".git"));
  await assert.rejects(discoverCurrentWorktree(config, task));
  await rm(join(task, ".git"));
  await writeFile(join(task, ".git"), original);
  const found = await discoverCurrentWorktree(config, task);
  const moved = join(base, "admin-moved");
  await rename(found.gitDir, moved);
  await symlink(moved, found.gitDir);
  await assert.rejects(discoverCurrentWorktree(config, task));
  const movedCommon = join(base, "common-moved");
  await rename(found.commonGitDir, movedCommon);
  await symlink(movedCommon, found.commonGitDir);
  await assert.rejects(discoverCurrentWorktree(config, config.repositoryPath), /canonical/);
});

test("missing/unborn HEAD and pre-aborted discovery fail without repairs", async (t) => {
  const { config } = await setupGit(t);
  await assert.rejects(discoverCurrentWorktree(config, config.repositoryPath, AbortSignal.abort()));
  await writeFile(join(config.repositoryPath, ".git/HEAD"), "ref: refs/heads/unborn\n");
  await assert.rejects(discoverCurrentWorktree(config, config.repositoryPath), /discovery failed/);
  assert.equal(await readFile(join(config.repositoryPath, ".git/HEAD"), "utf8"), "ref: refs/heads/unborn\n");
});

test("a missing promisor object cannot trigger a lazy fetch or external remote helper", async (t) => {
  const { base, config } = await setupGit(t);
  const head = await git(config.repositoryPath, ["rev-parse", "HEAD"]);
  const marker = join(base, "FETCH_EXECUTED");
  const script = join(base, "remote-command");
  await writeFile(script, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  await appendFile(join(config.repositoryPath, ".git/config"), `
[remote "origin"]
url = ext::${script}
promisor = true
[protocol "ext"]
allow = always
`);
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
  await appendFile(join(config.repositoryPath, ".git/config"), `
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
`);
  await writeFile(join(config.repositoryPath, ".gitattributes"), "* filter=host-command\n");
  poisonEnvironment(t, {
    PATH: shims, GIT_DIR: base, GIT_WORK_TREE: base, GIT_COMMON_DIR: base,
    GIT_CONFIG_GLOBAL: included, GIT_CONFIG_SYSTEM: included, GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: base,
    GIT_NAMESPACE: "wrong", GIT_TRACE: marker, GIT_EXEC_PATH: shims,
    GIT_INDEX_FILE: marker, GIT_OBJECT_DIRECTORY: base,
  });
  const found = await discoverCurrentWorktree(config, config.repositoryPath);
  assert.equal(found.worktreePath, config.repositoryPath);
  assert.equal(found.branch, "main");
  await validateBranchName("feature/task"); // The older branch helper must not use poisoned PATH either.
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});
