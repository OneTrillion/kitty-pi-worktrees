import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeService } from "../src/host/worktrees.ts";
import { acquireWorktreeLock } from "../src/host/lock.ts";
import { createRuntimeDirectory, prepareRuntimeRoot } from "../src/host/runtime.ts";
import { deriveWorktreePath, worktreeId } from "../src/host/paths.ts";
import { gitHelperArgs } from "../src/host/git-helper.ts";
import { ResponseSchema } from "../src/shared/protocol.ts";
import { setupDocker } from "./fixtures/docker.ts";
import { git } from "./fixtures/git.ts";

async function setup(t: Parameters<typeof setupDocker>[0]) {
  const fixture = await setupDocker(t);
  await prepareRuntimeRoot(fixture.config.runtimeRoot);
  const control = await createRuntimeDirectory(fixture.config.runtimeRoot);
  const client = await fixture.factory(fixture.config, control.directory);
  const locks: Array<Awaited<ReturnType<typeof acquireWorktreeLock>>> = [];
  const launches: string[] = [];
  const makeService = (source = fixture.config.repositoryPath) => createWorktreeService(fixture.config, source, client, {
    user: { uid: 1000, gid: 1000 },
    launch: async (path) => { launches.push(path); locks.push(await acquireWorktreeLock(fixture.config.runtimeRoot, path)); },
  });
  t.after(async () => { for (const lock of locks) await lock.release(); await control.remove(); });
  return { ...fixture, launches, locks, makeService, client };
}

test("real Git worker creates feature/nested tasks, records local parents and never copies dirty source files", async (t) => {
  const fixture = await setup(t);
  const repo = fixture.config.repositoryPath;
  await git(repo, ["branch", "-m", "feature/payments"]);
  await writeFile(join(repo, "file.txt"), "uncommitted source only\n");
  const created = await fixture.makeService().handle({ version: 1, op: "create-or-open", branch: "feature/task" });
  ResponseSchema.parse(created);
  assert.equal(created.ok, true);
  if (!created.ok || created.op !== "create-or-open") return;
  assert.equal(created.outcome, "created");
  assert.equal(created.worktree.open, true);
  assert.equal(created.worktree.upstream?.ref, "refs/heads/feature/payments");
  assert.equal(await readFile(join(created.worktree.path, "file.txt"), "utf8"), "initial\n");
  const nested = await fixture.makeService(created.worktree.path).handle({ version: 1, op: "create-or-open", branch: "task/docs" });
  assert.equal(nested.ok, true);
  if (nested.ok && nested.op === "create-or-open") assert.equal(nested.worktree.upstream?.ref, "refs/heads/feature/task");
  assert.equal(fixture.launches.length, 2);
});

test("closed worktrees reopen, active ones are reported without another Kitty launch", async (t) => {
  const fixture = await setup(t);
  const service = fixture.makeService();
  const first = await service.handle({ version: 1, op: "create-or-open", branch: "task" });
  assert.ok(first.ok && first.op === "create-or-open");
  const active = await service.handle({ version: 1, op: "create-or-open", branch: "task" });
  assert.ok(active.ok && active.op === "create-or-open");
  assert.equal(active.outcome, "already-active");
  assert.equal(fixture.launches.length, 1);
  await fixture.locks[0]!.release();
  await writeFile(join(first.worktree.path, "unfinished"), "preserved dirty work");
  const reopened = await service.handle({ version: 1, op: "open", worktreeId: first.worktree.id });
  assert.ok(reopened.ok && reopened.op === "open");
  assert.equal(reopened.outcome, "reopened");
  assert.equal(reopened.worktree.inspection, "ok");
  if (reopened.worktree.inspection === "ok") assert.equal(reopened.worktree.status, "dirty");
  assert.equal(fixture.launches.length, 2);
});

test("concurrent duplicate creation requests create one worktree and launch one tab", async (t) => {
  const fixture = await setup(t);
  const service = fixture.makeService();
  const replies = await Promise.all([1, 2].map(() => service.handle({ version: 1, op: "create-or-open", branch: "task" })));
  assert.ok(replies.every((reply) => reply.ok));
  assert.equal(fixture.launches.length, 1);
  assert.equal((await readdir(fixture.config.worktreeRoot)).length, 1);
});

test("listing is live, exposes prunable/locked metadata, and does not authorize outside paths", async (t) => {
  const fixture = await setup(t);
  const outside = join(fixture.base, "outside");
  await git(fixture.config.repositoryPath, ["worktree", "add", "-b", "outside", outside]);
  const missing = join(fixture.config.worktreeRoot, "missing");
  await git(fixture.config.repositoryPath, ["worktree", "add", "-b", "missing", missing]);
  await git(fixture.config.repositoryPath, ["worktree", "lock", "--reason", "keep", outside]);
  await rename(missing, join(fixture.base, "moved-manually"));
  const service = fixture.makeService();
  const listed = await service.handle({ version: 1, op: "list" });
  ResponseSchema.parse(listed);
  assert.ok(listed.ok && listed.op === "list");
  assert.equal(listed.worktrees.find((item) => item.path === outside)?.locked, true);
  assert.equal(listed.worktrees.find((item) => item.path === outside)?.inspection, "unavailable");
  assert.equal(listed.worktrees.find((item) => item.path === missing)?.prunable, true);
  const refused = await service.handle({ version: 1, op: "open", worktreeId: worktreeId(outside) });
  assert.equal(refused.ok, false);
  assert.equal(fixture.launches.length, 0);
  const unknown = await service.handle({ version: 1, op: "inspect", worktreeId: "0".repeat(64) });
  assert.ok(!unknown.ok && unknown.error.code === "not-found");
});

test("path collisions and invalid names preserve files and do not call Kitty", async (t) => {
  const fixture = await setup(t);
  const path = deriveWorktreePath(fixture.config.worktreeRoot, "collision");
  await mkdir(path);
  await writeFile(join(path, "keep"), "do not overwrite");
  const service = fixture.makeService();
  const collision = await service.handle({ version: 1, op: "create-or-open", branch: "collision" });
  assert.ok(!collision.ok && collision.error.code === "path-collision");
  for (const branch of ["../escape", "a;id", "/tmp/path", "@{-1}"]) assert.equal((await service.handle({ version: 1, op: "create-or-open", branch })).ok, false);
  assert.equal(await readFile(join(path, "keep"), "utf8"), "do not overwrite");
  assert.equal(fixture.launches.length, 0);
});

test("Kitty failure preserves newly created worktree and its local upstream", async (t) => {
  const fixture = await setup(t);
  const service = createWorktreeService(fixture.config, fixture.config.repositoryPath, fixture.client, {
    user: { uid: 1000, gid: 1000 }, launch: async () => { throw new Error("Kitty unavailable"); },
  });
  const result = await service.handle({ version: 1, op: "create-or-open", branch: "task" });
  assert.ok(!result.ok && result.error.code === "kitty-error");
  const path = deriveWorktreePath(fixture.config.worktreeRoot, "task");
  assert.equal(await git(path, ["rev-parse", "--symbolic-full-name", "@{upstream}"]), "refs/heads/main");
});

test("unconfirmed Kitty handoff reports uncertainty and preserves the new worktree without relaunching", async (t) => {
  const fixture = await setup(t);
  let launches = 0;
  const service = createWorktreeService(fixture.config, fixture.config.repositoryPath, fixture.client, {
    user: { uid: 1000, gid: 1000 }, launch: async () => { launches++; }, startupTimeoutMs: 1,
  });
  const result = await service.handle({ version: 1, op: "create-or-open", branch: "task" });
  assert.ok(!result.ok && result.error.code === "unavailable");
  assert.match(result.error.message, /startup was not confirmed/);
  assert.equal(launches, 1);
  const path = deriveWorktreePath(fixture.config.worktreeRoot, "task");
  assert.equal(await git(path, ["branch", "--show-current"]), "task");
  assert.deepEqual(await fixture.state(), []);
});

test("helper mount arguments expose no credentials, host API sockets or task-root parent", async (t) => {
  const { config } = await setup(t);
  const common = join(config.repositoryPath, ".git");
  const destination = deriveWorktreePath(config.worktreeRoot, "task");
  const args = gitHelperArgs(config, { op: "create", branch: "task", destination,
    source: { branch: "main", head: "a".repeat(40) }, location: { worktreePath: config.repositoryPath, gitDir: common, commonGitDir: common } },
  "12345678-1234-1234-1234-123456789abc", { uid: 1000, gid: 1000 });
  const mounts = args.flatMap((value, i) => value === "--mount" ? [args[i + 1]!] : []);
  assert.deepEqual(mounts, [`type=bind,src=${destination},dst=${destination}`, `type=bind,src=${common},dst=${common}`]);
  assert.ok(args.includes("--network=none") && args.includes("--read-only"));
  assert.doesNotMatch(args.join(" "), /type=volume|PI_WORKTREE_SOCKET|docker\.sock|KITTY|\/pi\/agent/);
});
