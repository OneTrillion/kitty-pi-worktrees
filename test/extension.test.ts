import assert from "node:assert/strict";

import test from "node:test";

import extension from "../src/extension/index.ts";

import type { GitState } from "../src/shared/git-state.ts";

import { parseTitle } from "../src/shared/title.ts";
import { clean, harness, task } from "./fixtures/extension.ts";

test("register exactly the five user commands, with no factory I/O, LLM tools or persistent task entries", async () => {
  const h = harness();
  assert.deepEqual(
    [...h.commands.keys()],
    ["worktree", "worktrees", "worktree-done", "worktree-sync", "worktree-merge"],
  );
  assert.equal(h.checks(), 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.titles.length, 0);
  await h.emit("session_start");
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "attention");
});

test("agent_settled, not agent_end, changes working to idle; done is transient", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.run("worktree-done");
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "done");
  h.idle(false);
  await h.emit("agent_start");
  await h.emit("agent_end");
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "working");
  h.idle(true);
  await h.emit("agent_settled");
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "attention");
  await h.run("worktree-done");
  await h.emit("session_shutdown");
  await h.emit("session_start");
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "attention");
});

test("worktree sends only a branch request; invalid names never reach the socket", async () => {
  const h = harness();
  await h.run("worktree", "feature/docs");
  assert.deepEqual(h.requests, [{ version: 1, op: "create-or-open", branch: "feature/docs" }]);
  for (const name of ["", "../escape", "x;id", "/tmp/task"]) await h.run("worktree", name);
  assert.equal(h.requests.length, 1);
  assert.ok(h.notices.some((notice) => notice.message.startsWith("created:")));
});

test("selector opens only the selected ID; cancellation performs no open", async () => {
  const h = harness();
  await h.run("worktrees");
  assert.deepEqual(
    h.requests.map((item) => item.op),
    ["list"],
  );
  h.choose(0);
  await h.run("worktrees");
  assert.deepEqual(h.requests.at(-1), { version: 1, op: "open", worktreeId: task.id });
});

test("sync conflict title stays local and merge requests a fresh task inspection", async () => {
  const h = harness();
  h.state({ ...clean, branch: "task", conflicts: true, dirty: true, operation: "merge", status: "conflict" });
  await h.run("worktree-sync");
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "conflict");
  assert.match(h.notices.at(-1)!.message, /target is unchanged/);
  h.state(clean);
  await h.run("worktree-merge", "task");
  assert.deepEqual(
    h.requests.map((request) => request.op),
    ["list", "inspect"],
  );
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "merged");
});

test("Git commands refuse an active agent, errors are plain text, and headless mode has no effects", async () => {
  const h = harness({
    request: async () => ({
      version: 1,
      ok: false,
      error: { code: "git-error", message: "bad\x1b]52;c;payload\x07\u202e" },
    }),
  });
  h.idle(false);
  await h.run("worktree-done");
  assert.equal(h.checks(), 0);
  h.idle(true);
  await h.run("worktree", "task");
  assert.doesNotMatch(h.notices.at(-1)!.message, /[\p{Cc}\p{Cf}]/u);
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "failed");
  h.ctx.hasUI = false;
  const count = h.notices.length;
  await h.run("worktrees");
  await h.emit("session_start");
  assert.equal(h.notices.length, count);
});

test("a stale startup read cannot overwrite working state", async () => {
  const pending = Promise.withResolvers<GitState>();
  const h = harness({
    git: () => ({
      prepare: async () => {},
      state: () => pending.promise,
      done: async () => clean,
      sync: async () => ({ state: clean, conflict: false }),
      integrate: async () => clean,
    }),
  });
  const started = h.emit("session_start");
  h.idle(false);
  await h.emit("agent_start");
  pending.resolve(clean);
  await started;
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "working");
});

test("shutdown cancels socket work and suppresses late UI replies", async () => {
  const entered = Promise.withResolvers<void>();
  const h = harness({
    request: async (_request, signal) => {
      entered.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    },
  });
  const command = h.run("worktree", "task");
  await entered.promise;
  const count = h.notices.length;
  await h.emit("session_shutdown");
  await command;
  assert.equal(h.notices.length, count);
});

test("default extension refuses local Git commands without supervisor mount metadata", async () => {
  const h = harness();
  extension(h.pi); // Replace handlers with the actual default adapters.
  await h.run("worktree-done");
  assert.match(h.notices.at(-1)!.message, /supervisor/);
});
