import assert from "node:assert/strict";

import { installWorktreeExtension } from "../../src/extension/index.ts";

import type {
  ExtensionDependencies,
  WorktreeContext,
  WorktreeExtensionAPI,
} from "../../src/extension/types.ts";

import type { GitState } from "../../src/shared/git-state.ts";

import type { Request, Response, Worktree } from "../../src/shared/protocol.ts";

export const clean: GitState = {
  branch: "main",
  head: "a".repeat(40),
  upstream: null,
  dirty: false,
  conflicts: false,
  operation: null,
  status: "clean",
};

export const task: Worktree = {
  ...clean,
  branch: "task",
  id: "b".repeat(64),
  path: "/repo/task",
  open: false,
  upstream: { ref: "refs/heads/main", kind: "local", exists: true },
  locked: false,
  lockReason: null,
  prunable: false,
  pruneReason: null,
  inspection: "ok",
};

export const harness = (overrides: Partial<ExtensionDependencies> = {}) => {
  const commands = new Map<string, { handler: (args: string, ctx: WorktreeContext) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: WorktreeContext) => void | Promise<void>>();
  const titles: string[] = [];
  const notices: Array<{ message: string; kind: string }> = [];
  const requests: Request[] = [];
  let idle = true;
  let choice: number | undefined = undefined;
  let state: GitState = { ...clean };
  let checks = 0;
  const git = {
    async prepare() {
      checks++;
    },
    async state() {
      return state;
    },
    async done() {
      checks++;
      return state;
    },
    async sync() {
      return { state, conflict: state.conflicts };
    },
    async integrate(_branch: string, inspect: () => Promise<GitState>) {
      assert.equal((await inspect()).branch, "task");
      return state;
    },
  };
  const pi = {
    registerCommand(name: string, spec: { handler: (args: string, ctx: WorktreeContext) => Promise<void> }) {
      commands.set(name, spec);
    },
    on(name: string, handler: (event: unknown, ctx: WorktreeContext) => void | Promise<void>) {
      events.set(name, handler);
    },
    registerTool() {
      throw new Error("Commands must not become LLM tools");
    },
    appendEntry() {
      throw new Error("Completion must not be persisted");
    },
    sendUserMessage() {
      throw new Error("Must not send worktree commands to the LLM");
    },
  };
  const ctx: WorktreeContext = {
    hasUI: true,
    cwd: "/repo/main",
    isIdle: () => idle,
    ui: {
      setTitle(value: string) {
        titles.push(value);
      },
      notify(message, kind = "info") {
        notices.push({ message, kind });
      },
      async select(_title: string, choices: string[]) {
        return choice === undefined ? undefined : choices[choice];
      },
    },
  };
  installWorktreeExtension(pi satisfies WorktreeExtensionAPI, {
    git: () => git,
    request: async (request): Promise<Response> => {
      requests.push(request);
      if (request.op === "list") return { version: 1, ok: true, op: "list", worktrees: [task] };
      if (request.op === "inspect") return { version: 1, ok: true, op: "inspect", worktree: task };
      if (request.op === "create-or-open")
        return { version: 1, ok: true, op: "create-or-open", outcome: "created", worktree: task };
      return { version: 1, ok: true, op: "open", outcome: "reopened", worktree: task };
    },
    ...overrides,
  });
  return {
    pi,
    ctx,
    titles,
    notices,
    requests,
    commands,
    events,
    git,
    state: (value: GitState) => {
      state = value;
    },
    idle: (value: boolean) => {
      idle = value;
    },
    choose: (index?: number) => {
      choice = index;
    },
    checks: () => checks,
    emit: async (name: string) => {
      await events.get(name)?.({}, ctx);
    },
    run: async (name: string, args = "") => {
      await commands.get(name)!.handler(args, ctx);
    },
  };
};
