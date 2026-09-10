import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeDirectory, prepareRuntimeRoot } from "../src/host/runtime.ts";
import { createWorktreeService } from "../src/host/worktrees.ts";
import { ResponseSchema } from "../src/shared/protocol.ts";
import { setupDocker } from "./fixtures/docker.ts";

const setup = async (t: Parameters<typeof setupDocker>[0]) => {
  const fixture = await setupDocker(t);
  const { config } = fixture;
  await prepareRuntimeRoot(config.runtimeRoot);
  const control = await createRuntimeDirectory(config.runtimeRoot);
  t.after(control.remove);
  const docker = await fixture.factory(config, control.directory);
  return { ...fixture, docker };
};

test("invalid startup deadlines are rejected before launching or allocating a worktree", async (t) => {
  const { config, docker, calls } = await setup(t);
  for (const startupTimeoutMs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createWorktreeService(config, config.repositoryPath, docker, { startupTimeoutMs }),
      /Invalid startup timeout/,
    );
  }
  assert.deepEqual(await calls(), []);
});

test("service rejects unknown inputs without contacting Docker", async (t) => {
  const { config, docker, calls } = await setup(t);
  const service = createWorktreeService(config, config.repositoryPath, docker);
  for (const input of [null, [], "list", { version: 1, op: "list", path: "/tmp" }]) {
    const reply = ResponseSchema.parse(await service.handle(input));
    assert.ok(!reply.ok && reply.error.code === "invalid-request");
  }
  assert.deepEqual(await calls(), []);
});

test("empty or control-only inspection errors remain valid unavailable responses", async (t) => {
  const { config, docker } = await setup(t);
  for (const message of ["", "\u0000\u202e"]) {
    const service = createWorktreeService(config, config.repositoryPath, docker, {
      helper: async () => {
        throw new Error(message);
      },
    });
    const reply = ResponseSchema.parse(await service.handle({ version: 1, op: "list" }));
    assert.ok(reply.ok && reply.op === "list");
    assert.equal(reply.worktrees.length, 1);
    const [worktree] = reply.worktrees;
    assert.ok(worktree?.inspection === "unavailable");
    assert.equal(worktree.error, "Inspection unavailable");
  }
});
