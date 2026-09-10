import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { discoverCurrentWorktree } from "../src/host/git-discovery.ts";
import { parseWorktreeRecords } from "../src/shared/worktree-records.ts";
import { git, setupGit } from "./fixtures/git.ts";

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
    worktreePath: config.repositoryPath,
    gitDir: join(config.repositoryPath, ".git"),
    commonGitDir: join(config.repositoryPath, ".git"),
    branch: "main",
    head: expected,
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
  assert.equal(
    await git(task, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
    "refs/heads/feature/payments",
  );
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
  assert.deepEqual(
    parseWorktreeRecords(
      `worktree /a b\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0worktree /a\nb\0detached\0\0`,
    ).map((record) => record.path),
    ["/a b", "/a\nb"],
  );
  for (const output of [
    "",
    "worktree /a\n\n",
    "HEAD abc\0\0",
    "worktree relative\0\0",
    "worktree /a\0HEAD invalid\0\0",
    "worktree /a\0\0worktree /a\0\0",
  ]) {
    assert.throws(() => parseWorktreeRecords(output));
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
