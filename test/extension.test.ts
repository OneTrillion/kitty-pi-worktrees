import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension, { installWorktreeExtension, type ExtensionDependencies } from "../src/extension/index.ts";
import type { GitState } from "../src/shared/git-state.ts";
import type { Request, Response, Worktree } from "../src/shared/protocol.ts";
import { parseTitle } from "../src/shared/title.ts";

const clean: GitState = { branch: "main", head: "a".repeat(40), upstream: null, dirty: false, conflicts: false, operation: null, status: "clean" };
const task: Worktree = { ...clean, branch: "task", id: "b".repeat(64), path: "/repo/task", open: false,
  upstream: { ref: "refs/heads/main", kind: "local", exists: true }, locked: false, lockReason: null, prunable: false, pruneReason: null, inspection: "ok" };

function harness(overrides: Partial<ExtensionDependencies> = {}) {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
  const titles: string[] = [];
  const notices: Array<{ message: string; kind: string }> = [];
  const requests: Request[] = [];
  let idle = true;
  let choice: number | undefined = undefined;
  let state: GitState = { ...clean };
  let checks = 0;
  const git = {
    async prepare() { checks++; }, async state() { return state; }, async done() { checks++; return state; },
    async sync() { return { state, conflict: state.conflicts }; },
    async integrate(_branch: string, inspect: () => Promise<GitState>) { assert.equal((await inspect()).branch, "task"); return state; },
  };
  const pi = {
    registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, spec); },
    on(name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) { events.set(name, handler); },
    registerTool() { throw new Error("Commands must not become LLM tools"); },
    appendEntry() { throw new Error("Completion must not be persisted"); },
    sendUserMessage() { throw new Error("Must not send worktree commands to the LLM"); },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true, cwd: "/repo/main", isIdle: () => idle,
    ui: {
      setTitle(value: string) { titles.push(value); },
      notify(message: string, kind: string) { notices.push({ message, kind }); },
      async select(_title: string, choices: string[]) { return choice === undefined ? undefined : choices[choice]; },
    },
  } as unknown as ExtensionCommandContext;
  installWorktreeExtension(pi, {
    git: () => git,
    request: async (request): Promise<Response> => {
      requests.push(request);
      if (request.op === "list") return { version: 1, ok: true, op: "list", worktrees: [task] };
      if (request.op === "inspect") return { version: 1, ok: true, op: "inspect", worktree: task };
      if (request.op === "create-or-open") return { version: 1, ok: true, op: "create-or-open", outcome: "created", worktree: task };
      return { version: 1, ok: true, op: "open", outcome: "reopened", worktree: task };
    }, ...overrides,
  });
  return { pi, ctx, titles, notices, requests, commands, events, git,
    state: (value: GitState) => { state = value; }, idle: (value: boolean) => { idle = value; }, choose: (index?: number) => { choice = index; },
    checks: () => checks,
    emit: async (name: string) => { await events.get(name)?.({}, ctx); },
    run: async (name: string, args = "") => { await commands.get(name)!.handler(args, ctx); },
  };
}

test("register exactly the five user commands, with no factory I/O, LLM tools or persistent task entries", async () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["worktree", "worktrees", "worktree-done", "worktree-sync", "worktree-merge"]);
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
  assert.deepEqual(h.requests.map((item) => item.op), ["list"]);
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
  assert.deepEqual(h.requests.map((request) => request.op), ["list", "inspect"]);
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "merged");
});

test("Git commands refuse an active agent, errors are plain text, and headless mode has no effects", async () => {
  const h = harness({ request: async () => ({ version: 1, ok: false, error: { code: "git-error", message: "bad\x1b]52;c;payload\x07\u202e" } }) });
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
  const h = harness({ git: () => ({ prepare: async () => {}, state: () => pending.promise, done: async () => clean,
    sync: async () => ({ state: clean, conflict: false }), integrate: async () => clean }) });
  const started = h.emit("session_start");
  h.idle(false);
  await h.emit("agent_start");
  pending.resolve(clean);
  await started;
  assert.equal(parseTitle(h.titles.at(-1)!)?.state, "working");
});

test("shutdown cancels socket work and suppresses late UI replies", async () => {
  const entered = Promise.withResolvers<void>();
  const h = harness({ request: async (_request, signal) => {
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
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
