import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ROLE_LABEL } from "../src/host/container-cleanup.ts";
import { locateGit } from "../src/host/git-discovery.ts";
import {
  gitHelperArgs,
  gitHelperName,
  recoverGitHelper,
  runHelper,
  withRepositoryLock,
} from "../src/host/git-helper.ts";
import { acquireWorktreeLock, isWorktreeOpen, WorktreeBusyError } from "../src/host/lock.ts";
import { createRuntimeDirectory, prepareRuntimeRoot } from "../src/host/runtime.ts";
import type { HelperRequest } from "../src/shared/helper.ts";
import { eventually, setupDocker } from "./fixtures/docker.ts";

const setup = async (t: Parameters<typeof setupDocker>[0]) => {
  const fixture = await setupDocker(t);
  await prepareRuntimeRoot(fixture.config.runtimeRoot);
  const control = await createRuntimeDirectory(fixture.config.runtimeRoot);
  t.after(() => control.remove());
  const client = await fixture.factory(fixture.config, control.directory);
  const location = await locateGit(fixture.config, fixture.config.repositoryPath);
  const request: HelperRequest = { op: "inspect", location };
  const user = { uid: 1000, gid: 1000 };
  const run = (signal?: AbortSignal) =>
    withRepositoryLock(
      fixture.config,
      () => runHelper(fixture.config, client, request, signal, user),
      signal,
    );
  const allocate = () => client.create(gitHelperArgs(fixture.config, request, randomUUID(), user));
  return { ...fixture, client, request, run, allocate, common: location.commonGitDir };
};

test("orphan helper blocks task startup and helper reuse; explicit recovery preserves task containers and files", async (t) => {
  const f = await setup(t);
  const id = await f.allocate();
  const containers = await f.state();
  containers[0]!.State.Running = true;
  const other = { ...containers[0]!, Id: "f".repeat(64), Name: "/unrelated-task", Config: { Labels: {} } };
  containers.push(other);
  await f.save(containers);
  await assert.rejects(f.run(), /helper still exists/);
  // runHostSession is exercised with the same fake daemon below.
  const { runHostSession } = await import("../src/host/supervisor.ts");
  await assert.rejects(
    runHostSession(f.config, f.config.repositoryPath, "start", {
      dockerFactory: f.factory,
      containerUser: { uid: 1000, gid: 1000 },
    }),
    /Git helper is active or left over/,
  );
  await recoverGitHelper(f.config, f.client);
  assert.deepEqual(
    (await f.state()).map((item) => item.Id),
    [other.Id],
  );
  assert.equal(await readFile(join(f.config.repositoryPath, "file.txt"), "utf8"), "initial\n");
  const destructive = (await f.calls()).filter((call) => ["stop", "rm"].includes(call.argv[5]!));
  assert.ok(destructive.length >= 2);
  assert.ok(destructive.every((call) => call.argv.at(-1) === id));
  await recoverGitHelper(f.config, f.client); // absent is a no-op
});

test("recover-git refuses a live repository mutex and unrecognized name/role ownership", async (t) => {
  const f = await setup(t);
  await f.allocate();
  const lock = await acquireWorktreeLock(f.config.runtimeRoot, f.common);
  try {
    await assert.rejects(recoverGitHelper(f.config, f.client), WorktreeBusyError);
  } finally {
    await lock.release();
  }
  const items = await f.state();
  delete items[0]!.Config.Labels![ROLE_LABEL];
  await f.save(items);
  await assert.rejects(recoverGitHelper(f.config, f.client), /Unrecognized/);
  assert.equal((await f.state()).length, 1);
  assert.equal(
    (await f.calls()).some((call) => ["stop", "rm"].includes(call.argv[5]!)),
    false,
  );
});

for (const [control, pattern] of [
  ["failCreate", /Docker create failed/],
  ["loseCreateReply", /Invalid/],
  ["failAttach", /Docker container failed/],
  ["badHelperReply", /JSON/],
] satisfies Array<[string, RegExp]>) {
  test(`helper ${control} cleans up before releasing the repository lock`, async (t) => {
    const f = await setup(t);
    await f.controls({ [control]: true });
    await assert.rejects(f.run(), pattern);
    assert.deepEqual(await f.state(), []);
    assert.equal(await isWorktreeOpen(f.config.runtimeRoot, f.common), false);
  });
}

test("helper create-name race never removes an unrecognized container", async (t) => {
  const f = await setup(t);
  await f.controls({ conflictOnCreate: true });
  await assert.rejects(f.run(), /Docker create failed/);
  assert.equal((await f.state())[0]?.Name, `/${gitHelperName(f.config)}`);
  assert.equal(
    (await f.calls()).some((call) => call.argv[5] === "rm"),
    false,
  );
});

test("cancelling an attached helper confirms removal before unlocking", async (t) => {
  const f = await setup(t);
  await f.controls({ helperDelayMs: 60000 });
  const abort = new AbortController();
  const running = f.run(abort.signal);
  const rejected = assert.rejects(running);
  await eventually(f.state, (items) => items.some((item) => item.State.Running));
  assert.equal(await isWorktreeOpen(f.config.runtimeRoot, f.common), true);
  abort.abort();
  await rejected;
  assert.deepEqual(await f.state(), []);
  assert.equal(await isWorktreeOpen(f.config.runtimeRoot, f.common), false);
});

test("cancellation during helper create removes the late stopped container without starting it", async (t) => {
  const f = await setup(t);
  await f.controls({ createDelayMs: 200 });
  const abort = new AbortController();
  const rejected = assert.rejects(f.run(abort.signal));
  await eventually(f.state, (items) => items.length === 1);
  abort.abort();
  await rejected;
  assert.deepEqual(await f.state(), []);
  assert.equal(
    (await f.calls()).some((call) => call.argv[5] === "start"),
    false,
  );
  assert.equal(await isWorktreeOpen(f.config.runtimeRoot, f.common), false);
});

test("cancellation while waiting for the repo mutex does not create a helper", async (t) => {
  const f = await setup(t);
  const lock = await acquireWorktreeLock(f.config.runtimeRoot, f.common);
  try {
    await assert.rejects(f.run(AbortSignal.timeout(50)));
    assert.deepEqual(await f.calls(), []);
  } finally {
    await lock.release();
  }
});

test("uncertain helper removal retains the repository mutex until Docker recovers", async (t) => {
  const f = await setup(t);
  await f.controls({ failRemove: true });
  const running = f.run();
  try {
    await eventually(f.calls, (calls) => calls.some((call) => call.argv[5] === "rm"));
    assert.equal(await isWorktreeOpen(f.config.runtimeRoot, f.common), true);
    await assert.rejects(recoverGitHelper(f.config, f.client), WorktreeBusyError);
  } finally {
    await f.controls({ failRemove: false });
  }
  assert.ok(await running);
  assert.equal(await isWorktreeOpen(f.config.runtimeRoot, f.common), false);
  assert.deepEqual(await f.state(), []);
});

test("helper rejects mount replacement after stopped creation, without executing the worker", async (t) => {
  const f = await setup(t);
  const replacement = join(f.base, "replacement");
  const saved = join(f.base, "saved");
  await mkdir(replacement);
  await writeFile(join(replacement, "keep"), "replacement");
  await f.controls({ swapAfterCreate: { path: f.config.repositoryPath, replacement, saved } });
  await assert.rejects(f.run(), /mount directory changed/);
  assert.deepEqual(await f.state(), []);
  assert.equal(
    (await f.calls()).some((call) => call.argv[5] === "start"),
    false,
  );
  assert.equal(await readFile(join(saved, "file.txt"), "utf8"), "initial\n");
});
