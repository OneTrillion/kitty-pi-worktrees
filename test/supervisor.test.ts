import assert from "node:assert/strict";

import { cp, lstat, readdir, readFile, writeFile } from "node:fs/promises";

import { join } from "node:path";

import test from "node:test";

import { REPOSITORY_LABEL, RUN_LABEL, WORKTREE_LABEL } from "../src/host/docker.ts";

import { isWorktreeOpen } from "../src/host/lock.ts";

import { requestSupervisor } from "../src/shared/client.ts";

import { setupDocker } from "./fixtures/docker.ts";

import { operations, ownedLeftover, running, socketPath } from "./fixtures/supervisor.ts";

test("start attaches while serving requests, propagates exit status, and preserves worktree files", async (t) => {
  const fixture = await setupDocker(t);
  await writeFile(join(fixture.config.repositoryPath, "file.txt"), "dirty changes\n");
  await writeFile(join(fixture.config.repositoryPath, "untracked"), "untracked changes\n");
  const session = fixture.run();
  const container = await running(fixture);
  assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), true);
  const response = await requestSupervisor(socketPath(container), { version: 1, op: "list" });
  assert.equal(response.ok, true);
  if (response.ok && response.op === "list") {
    assert.equal(response.worktrees[0]!.inspection, "ok");
    assert.equal(response.worktrees[0]!.open, true);
  }
  container.State.Running = false;
  container.exitCode = 7;
  await fixture.save([container]);
  assert.equal(await session.result, 7);
  assert.deepEqual(await fixture.state(), []);
  assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), false);
  assert.ok((await readdir(fixture.config.runtimeRoot)).every((name) => name.endsWith(".lock")));
  await assert.rejects(lstat(socketPath(container)), { code: "ENOENT" });
  assert.equal(await readFile(join(fixture.config.repositoryPath, "file.txt"), "utf8"), "dirty changes\n");
  assert.equal(
    await readFile(join(fixture.config.repositoryPath, "untracked"), "utf8"),
    "untracked changes\n",
  );
  const calls = await operations(fixture);
  assert.ok(
    calls.some((args) => args[0] === "create" && args.includes("--pull=never") && !args.includes("--rm")),
  );
  assert.ok(
    calls.some((args) => args.join(" ") === `container start --attach --interactive ${container.Id}`),
  );
  assert.ok(calls.some((args) => args.join(" ") === `container rm ${container.Id}`));
  assert.ok(calls.every((args) => !args.includes("--volumes") && !args.includes("--force")));
});

test("a second session is refused before Docker creation and cannot stop the first", async (t) => {
  const fixture = await setupDocker(t);
  const first = fixture.run();
  const container = await running(fixture);
  await assert.rejects(fixture.run().result, /already open/);
  await assert.rejects(fixture.run("recover").result, /already open/);
  assert.equal((await operations(fixture)).filter((args) => args[0] === "create").length, 1);
  assert.equal((await fixture.state())[0]!.Id, container.Id);
  first.abort.abort();
  assert.equal(await first.result, 130);
});

test("start refuses a managed orphan; explicit recovery verifies ownership and removes only that ID", async (t) => {
  const fixture = await setupDocker(t);
  const orphan = ownedLeftover(fixture);
  await fixture.save([orphan]);
  await assert.rejects(fixture.run().result, /already occupies/);
  assert.deepEqual(await fixture.state(), [orphan]);
  assert.equal(await fixture.run("recover").result, 0);
  assert.deepEqual(await fixture.state(), []);
  const calls = await operations(fixture);
  assert.ok(calls.some((args) => args.join(" ") === `container stop --time 10 ${orphan.Id}`));
  assert.ok(calls.some((args) => args.join(" ") === `container rm ${orphan.Id}`));
  assert.equal(await fixture.run("recover").result, 0); // Nothing left is a no-op.
});

test("foreign or mismatched ownership labels are never accepted for recovery", async (t) => {
  const fixture = await setupDocker(t);
  for (const label of [null, WORKTREE_LABEL, REPOSITORY_LABEL, RUN_LABEL]) {
    const foreign = ownedLeftover(fixture, label !== null);
    if (label) foreign.Config.Labels![label] = "wrong";
    await fixture.save([foreign]);
    await assert.rejects(fixture.run("recover").result, /unrecognized/);
    assert.deepEqual(await fixture.state(), [foreign]);
  }
  assert.ok((await operations(fixture)).every((args) => !["stop", "rm", "start"].includes(args[1] ?? "")));
});

test("a name collision racing with create is not mistaken for our container during cleanup", async (t) => {
  const fixture = await setupDocker(t);
  await fixture.controls({ conflictOnCreate: true });
  await assert.rejects(fixture.run().result, /Docker create failed/);
  assert.equal((await fixture.state()).length, 1);
  assert.deepEqual((await fixture.state())[0]!.Config.Labels, {});
  assert.ok((await operations(fixture)).every((args) => !["stop", "rm", "start"].includes(args[1] ?? "")));
  assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), false);
});

for (const control of ["failCreate", "loseCreateReply", "failAttach"]) {
  test(`${control} leaves no editing container, socket, or held lock`, async (t) => {
    const fixture = await setupDocker(t);
    await fixture.controls({ [control]: true });
    const result = fixture.run().result;
    if (control === "failAttach") assert.equal(await result, 125);
    else await assert.rejects(result);
    assert.deepEqual(await fixture.state(), []);
    assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), false);
    assert.ok((await readdir(fixture.config.runtimeRoot)).every((name) => name.endsWith(".lock")));
    if (control !== "failAttach") assert.ok((await operations(fixture)).every((args) => args[1] !== "start"));
  });
}

test("mount/Git metadata are revalidated after create and before any attached start", async (t) => {
  const fixture = await setupDocker(t);
  const headPath = join(fixture.config.repositoryPath, ".git/HEAD");
  await fixture.controls({ mutateAfterCreate: { path: headPath, text: "ref: refs/heads/unborn\n" } });
  await assert.rejects(fixture.run().result, /discovery failed/);
  assert.ok((await operations(fixture)).every((args) => args[1] !== "start"));
  assert.deepEqual(await fixture.state(), []);
  assert.equal(await readFile(headPath, "utf8"), "ref: refs/heads/unborn\n"); // No repair/rollback of user Git state.
});

test("replacing a mount directory with a same-content copy is detected by inode revalidation", async (t) => {
  const fixture = await setupDocker(t);
  const replacement = join(fixture.base, "replacement");
  const saved = join(fixture.base, "original");
  await cp(fixture.config.repositoryPath, replacement, { recursive: true });
  await fixture.controls({ swapAfterCreate: { path: fixture.config.repositoryPath, replacement, saved } });
  await assert.rejects(fixture.run().result, /mount directory changed/);
  assert.ok((await operations(fixture)).every((args) => args[1] !== "start"));
  assert.deepEqual(await fixture.state(), []);
  assert.ok((await lstat(saved)).isDirectory());
});

test("a replaced private socket is rejected before container start", async (t) => {
  const fixture = await setupDocker(t);
  await fixture.controls({ replaceSocketAfterCreate: true });
  await assert.rejects(fixture.run().result, /socket changed/);
  assert.ok((await operations(fixture)).every((args) => args[1] !== "start"));
  assert.deepEqual(await fixture.state(), []);
});

test("preflight daemon errors are not interpreted as an empty container list", async (t) => {
  const fixture = await setupDocker(t);
  await fixture.controls({ failLookup: true });
  await assert.rejects(fixture.run().result, /Docker container failed/);
  assert.ok((await operations(fixture)).every((args) => args[0] !== "create"));
  assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), false);
});

test("Docker control uses the fixed endpoint and private config, not inherited host credentials or control environment", async (t) => {
  const fixture = await setupDocker(t);
  const previous = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "tcp://not-the-configured-daemon:2375";
  t.after(() => {
    if (previous === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous;
  });
  await fixture.controls({ exitCode: 0 });
  assert.equal(await fixture.run().result, 0);
  for (const call of await fixture.calls()) {
    assert.deepEqual(call.argv.slice(0, 2), ["--host", `unix://${fixture.config.dockerSocket}`]);
    assert.equal(call.argv[2], "--config");
    assert.ok(call.argv[3]!.startsWith(fixture.config.runtimeRoot + "/"));
    for (const key of [
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "KITTY_LISTEN_ON",
      "ANTHROPIC_API_KEY",
      "NODE_OPTIONS",
    ]) {
      assert.equal(call.env[key], undefined);
    }
  }
});
