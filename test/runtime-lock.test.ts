import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireWorktreeLock, isWorktreeOpen, WorktreeBusyError } from "../src/host/lock.ts";
import { worktreeId } from "../src/host/paths.ts";
import { createRuntimeDirectory, prepareRuntimeRoot } from "../src/host/runtime.ts";

const setup = async (t: TestContext) => {
  const base = await mkdtemp(join(tmpdir(), "pw-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await prepareRuntimeRoot(join(base, "runtime"));
  const worktree = join(base, "repo");
  await mkdir(worktree);
  return { base, root, worktree };
};

test("private per-tab directories have unique socket paths and idempotent cleanup", async (t) => {
  const { root } = await setup(t);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal(await prepareRuntimeRoot(root), root);
  const a = await createRuntimeDirectory(root);
  const b = await createRuntimeDirectory(root);
  assert.notEqual(a.socketPath, b.socketPath);
  assert.equal((await lstat(a.directory)).mode & 0o777, 0o700);
  await a.remove();
  await a.remove();
  assert.ok((await lstat(b.directory)).isDirectory());
  await b.remove();
  assert.deepEqual(await readdir(root), []);
});

test("reject insecure/symlink runtime roots rather than changing their permissions", async (t) => {
  const { base, root } = await setup(t);
  await chmod(root, 0o755);
  await assert.rejects(prepareRuntimeRoot(root), /0700/);
  await assert.rejects(createRuntimeDirectory(root), /0700/);
  assert.equal((await lstat(root)).mode & 0o777, 0o755);
  const alias = join(base, "alias");
  await symlink(root, alias);
  await assert.rejects(prepareRuntimeRoot(alias), /0700/);
  await assert.rejects(prepareRuntimeRoot(join(alias, "child")), /canonical/);
  await assert.rejects(prepareRuntimeRoot("relative"), /absolute/);
});

test("socket path byte limit fails before allocating a per-tab directory", async (t) => {
  const { base } = await setup(t);
  const root = await prepareRuntimeRoot(join(base, "é".repeat(40)));
  await assert.rejects(createRuntimeDirectory(root), /too long/);
  assert.deepEqual(await readdir(root), []);
});

test(
  "advisory lock persists after flock exits, rejects duplicates and aliases, and reuses its inode",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { base, root, worktree } = await setup(t);
    const alias = join(base, "alias");
    await symlink(worktree, alias);
    assert.equal(await isWorktreeOpen(root, worktree), false);
    const first = await acquireWorktreeLock(root, worktree);
    t.after(first.release);
    assert.equal(await isWorktreeOpen(root, alias), true);
    await assert.rejects(acquireWorktreeLock(root, alias), WorktreeBusyError);
    const lockPath = join(root, `${worktreeId(worktree)}.lock`);
    const info = await lstat(lockPath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(await readFile(lockPath, "utf8"), "");
    await first.release();
    await first.release();
    assert.equal(await isWorktreeOpen(root, worktree), false);
    const second = await acquireWorktreeLock(root, alias);
    t.after(second.release);
    assert.equal(second.canonicalPath, worktree);
    assert.equal((await lstat(lockPath)).ino, info.ino); // Never unlink lock files.
  },
);

test(
  "concurrent attempts have exactly one winner; different worktrees can both lock",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { base, root, worktree } = await setup(t);
    const results = await Promise.allSettled([
      acquireWorktreeLock(root, worktree),
      acquireWorktreeLock(root, worktree),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results) {
      if (result.status === "fulfilled") t.after(result.value.release);
      else assert.ok(result.reason instanceof WorktreeBusyError);
    }
    const other = join(base, "other");
    await mkdir(other);
    const otherLock = await acquireWorktreeLock(root, other);
    t.after(otherLock.release);
    assert.equal(await isWorktreeOpen(root, other), true);
  },
);

test(
  "lock rejects symlinks, hard links and insecure files without overwriting data",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { base, root, worktree } = await setup(t);
    const target = join(base, "sentinel");
    const lockPath = join(root, `${worktreeId(worktree)}.lock`);
    await writeFile(target, "preserve me", { mode: 0o600 });
    await symlink(target, lockPath);
    await assert.rejects(acquireWorktreeLock(root, worktree));
    await rm(lockPath);
    await link(target, lockPath);
    await assert.rejects(acquireWorktreeLock(root, worktree), /hard links/);
    await rm(lockPath);
    await writeFile(lockPath, "not our private file", { mode: 0o644 });
    await assert.rejects(acquireWorktreeLock(root, worktree), /0600/);
    assert.equal(await readFile(target, "utf8"), "preserve me");
    assert.equal(await readFile(lockPath, "utf8"), "not our private file");
  },
);

test(
  "SIGKILL releases the OS lock without stale-lock files needing repair",
  { skip: process.platform !== "linux", timeout: 10000 },
  async (t) => {
    const { root, worktree } = await setup(t);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/lock-holder.ts", import.meta.url)), root, worktree],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Lock holder exited before readiness")));
    });
    assert.equal(await isWorktreeOpen(root, worktree), true);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const lock = await acquireWorktreeLock(root, worktree);
    await lock.release();
  },
);
