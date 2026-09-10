import assert from "node:assert/strict";

import { readFile, writeFile } from "node:fs/promises";

import { join } from "node:path";

import test from "node:test";

import { containerName } from "../src/host/docker.ts";

import { isWorktreeOpen } from "../src/host/lock.ts";

import { eventually, setupDocker } from "./fixtures/docker.ts";

import { childSession, operations, running } from "./fixtures/supervisor.ts";

for (const control of ["failStop", "failRemove", "failLookup"]) {
  test(`${control} during cleanup holds the lock until Docker confirms removal`, async (t) => {
    const fixture = await setupDocker(t);
    const session = fixture.run();
    await running(fixture);
    await fixture.controls({ [control]: true });
    session.abort.abort();
    await eventually(
      async () => fixture.notices,
      (messages) => messages.some((message) => message.includes("retaining")),
    );
    assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), true);
    assert.equal((await fixture.state()).length, 1);
    await fixture.controls({ [control]: false });
    assert.equal(await session.result, 130);
    assert.deepEqual(await fixture.state(), []);
    assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), false);
  });
}

test("cancellation during create does not start a late-created container", async (t) => {
  const fixture = await setupDocker(t);
  await fixture.controls({ createDelayMs: 200 });
  const session = fixture.run();
  await eventually(fixture.state, (items) => items.length === 1);
  session.abort.abort();
  assert.equal(await session.result, 130);
  assert.ok((await operations(fixture)).every((args) => args[1] !== "start"));
  assert.deepEqual(await fixture.state(), []);
});

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] satisfies Array<[NodeJS.Signals, number]>) {
  test(
    `${signal} stops/removes the container before the supervisor process exits`,
    { timeout: 15000 },
    async (t) => {
      const fixture = await setupDocker(t);
      const session = childSession(t, fixture);
      await running(fixture);
      session.child.kill(signal);
      const exited = await session.exited;
      assert.deepEqual(exited, { code, signal: null }, session.stderr());
      assert.deepEqual(await fixture.state(), []);
      assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), false);
    },
  );
}

test(
  "SIGKILL during create can leave only a stopped container, recoverable without ever starting it",
  { timeout: 15000 },
  async (t) => {
    const fixture = await setupDocker(t);
    await fixture.controls({ createDelayMs: 200 });
    const session = childSession(t, fixture);
    await eventually(fixture.state, (items) => items.length === 1);
    session.child.kill("SIGKILL");
    await session.exited;
    assert.equal((await fixture.state())[0]!.State.Running, false);
    await assert.rejects(fixture.run().result, /already occupies/);
    assert.equal(await fixture.run("recover").result, 0);
    assert.deepEqual(await fixture.state(), []);
    assert.ok((await operations(fixture)).every((args) => args[1] !== "start"));
  },
);

test(
  "SIGKILL leaves a detectable orphan; no second container starts and host recovery permits reopening",
  { timeout: 20000 },
  async (t) => {
    const fixture = await setupDocker(t);
    await writeFile(join(fixture.config.repositoryPath, "untracked"), "preserved across supervisor death");
    const session = childSession(t, fixture);
    const orphan = await running(fixture);
    session.child.kill("SIGKILL");
    assert.equal((await session.exited).signal, "SIGKILL");
    assert.equal(await isWorktreeOpen(fixture.config.runtimeRoot, fixture.config.repositoryPath), false);
    assert.equal((await fixture.state())[0]!.State.Running, true);
    await assert.rejects(fixture.run().result, /already occupies/);
    assert.equal((await operations(fixture)).filter((args) => args[0] === "create").length, 1);
    assert.equal(await fixture.run("recover").result, 0);
    assert.deepEqual(await fixture.state(), []);
    await fixture.controls({ exitCode: 0 });
    assert.equal(await fixture.run().result, 0);
    assert.equal(
      await readFile(join(fixture.config.repositoryPath, "untracked"), "utf8"),
      "preserved across supervisor death",
    );
    assert.equal(orphan.Name, `/${containerName(fixture.config.repositoryPath)}`);
  },
);
