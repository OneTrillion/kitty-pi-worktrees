import { assertBranchName } from "../shared/branch.ts";
import type { GitState } from "../shared/git-state.ts";
import type { Request, Response, Worktree } from "../shared/protocol.ts";
import { plainText } from "../shared/title.ts";
import type { createExtensionSession } from "./session.ts";
import type { ExtensionDependencies, WorktreeContext } from "./types.ts";

const taskState = (worktree: Worktree): GitState => {
  if (worktree.inspection !== "ok" || !worktree.head)
    throw new Error(worktree.inspection === "unavailable" ? worktree.error : "Task commit is unavailable");
  const { branch, head, upstream, status, dirty, conflicts, operation } = worktree;
  return { branch, head, upstream, status, dirty, conflicts, operation };
};

export const registerWorktreeCommands = (
  { command, title }: ReturnType<typeof createExtensionSession>,
  deps: ExtensionDependencies,
): void => {
  const request = async (message: Request, signal: AbortSignal): Promise<Extract<Response, { ok: true }>> => {
    const reply = await deps.request(message, signal);
    signal.throwIfAborted();
    if (!reply.ok) throw new Error(reply.error.message);
    if (reply.op !== message.op) throw new Error("Supervisor response operation mismatch");
    return reply;
  };

  const noArgs = (args: string): void => {
    if (args.trim()) throw new Error("This command takes no arguments");
  };
  const idle = (ctx: WorktreeContext): void => {
    if (!ctx.isIdle()) throw new Error("Wait for the current agent to settle before changing Git state");
  };

  command("worktree", "Create or reopen a worktree in a new Kitty tab", async (args, ctx, signal) => {
    if (!args) throw new Error("Usage: /worktree <local-branch>");
    assertBranchName(args);
    const reply = await request({ version: 1, op: "create-or-open", branch: args }, signal);
    if (reply.op === "create-or-open")
      ctx.ui.notify(`${reply.outcome}: ${plainText(reply.worktree.path)}`, "info");
  });
  command("worktrees", "List Git worktrees and open a selected closed one", async (args, ctx, signal) => {
    noArgs(args);
    const reply = await request({ version: 1, op: "list" }, signal);
    if (reply.op !== "list") return;
    const choices = reply.worktrees.map((item, index) =>
      [
        `${index + 1}. ${plainText(item.branch ?? "(detached)")}`,
        plainText(item.path),
        plainText(item.upstream?.ref ?? "no upstream"),
        item.head?.slice(0, 10) ?? "?",
        item.open ? "open" : "closed",
        item.inspection === "ok" ? item.status : `unavailable: ${plainText(item.error)}`,
        item.locked ? `git-locked: ${plainText(item.lockReason ?? "")}` : "",
        item.prunable ? `prunable: ${plainText(item.pruneReason ?? "")}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    );
    const choice = await ctx.ui.select("Git worktrees", choices, { signal });
    if (choice === undefined || signal.aborted) return;
    const index = choices.indexOf(choice);
    const selected = reply.worktrees[index];
    if (!selected) return;
    const opened = await request({ version: 1, op: "open", worktreeId: selected.id }, signal);
    if (opened.op === "open") ctx.ui.notify(`${opened.outcome}: ${plainText(opened.worktree.path)}`, "info");
  });
  command(
    "worktree-done",
    "Mark committed, conflict-free work done (Git checks only)",
    async (args, ctx, signal) => {
      noArgs(args);
      idle(ctx);
      const state = await deps.git(ctx).done(signal);
      signal.throwIfAborted();
      title(ctx, "done", state.branch);
      ctx.ui.notify("Done: clean and committed. No project tests were run.", "info");
    },
  );
  command("worktree-sync", "Merge the local parent branch into this task", async (args, ctx, signal) => {
    noArgs(args);
    idle(ctx);
    title(ctx, "working");
    const result = await deps.git(ctx).sync(signal);
    signal.throwIfAborted();
    title(ctx, result.conflict ? "conflict" : "attention", result.state.branch);
    ctx.ui.notify(
      result.conflict
        ? "Conflicts remain in this task. Resolve and commit them here; the target is unchanged."
        : "Synced with the local parent. No project tests were run.",
      result.conflict ? "warning" : "info",
    );
  });
  command(
    "worktree-merge",
    "Fast-forward this target from a clean task branch",
    async (args, ctx, signal) => {
      idle(ctx);
      assertBranchName(args);
      const listed = await request({ version: 1, op: "list" }, signal);
      if (listed.op !== "list") return;
      const tasks = listed.worktrees.filter((item) => item.branch === args);
      const [task] = tasks;
      if (tasks.length !== 1 || !task)
        throw new Error("Select a task branch with exactly one linked worktree");
      title(ctx, "working");
      const state = await deps.git(ctx).integrate(
        args,
        async () => {
          const inspected = await request({ version: 1, op: "inspect", worktreeId: task.id }, signal);
          if (inspected.op !== "inspect") throw new Error("Expected task inspection");
          return taskState(inspected.worktree);
        },
        signal,
      );
      signal.throwIfAborted();
      title(ctx, "merged", state.branch);
      ctx.ui.notify(
        "Target fast-forwarded. Task branch/worktree preserved; no project tests were run.",
        "info",
      );
    },
  );
};
