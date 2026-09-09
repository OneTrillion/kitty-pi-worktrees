import { isAbsolute, normalize } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { GitOperations } from "../git/operations.ts";
import { assertBranchName } from "../shared/branch.ts";
import { requestSupervisor } from "../shared/client.ts";
import type { GitState } from "../shared/git-state.ts";
import type { Request, Response, Worktree } from "../shared/protocol.ts";
import { formatTitle, plainText, type TitleState } from "../shared/title.ts";

type GitAPI = Pick<GitOperations, "prepare" | "state" | "done" | "sync" | "integrate">;
export interface ExtensionDependencies {
  git(ctx: ExtensionContext): GitAPI;
  request(request: Request, signal: AbortSignal): Promise<Response>;
}

function mountedGit(ctx: ExtensionContext): GitOperations {
  const root = process.env.PI_WORKTREE_ROOT;
  const gitDir = process.env.PI_WORKTREE_GIT_DIR;
  const commonGitDir = process.env.PI_WORKTREE_COMMON_GIT_DIR;
  if (!process.env.PI_WORKTREE_SOCKET || !root || !gitDir || !commonGitDir ||
      [root, gitDir, commonGitDir].some((path) => !isAbsolute(path) || normalize(path) !== path) || ctx.cwd !== root ||
      !(gitDir === commonGitDir || gitDir.startsWith(commonGitDir + "/"))) {
    throw new Error("Launch Pi through the worktree supervisor in its selected worktree; Git commands are container-only");
  }
  return new GitOperations({ worktreePath: root, gitDir, commonGitDir });
}

function taskState(worktree: Worktree): GitState {
  if (worktree.inspection !== "ok" || !worktree.head) throw new Error(worktree.inspection === "unavailable" ? worktree.error : "Task commit is unavailable");
  const { branch, head, upstream, status, dirty, conflicts, operation } = worktree;
  return { branch, head, upstream, status, dirty, conflicts, operation };
}

/** No factory-time I/O, persisted task entries, LLM tools, or sendUserMessage calls. */
export function installWorktreeExtension(pi: ExtensionAPI, deps: ExtensionDependencies): void {
  let lifetime = new AbortController();
  let revision = 0;
  let branch: string | null | undefined;
  let activeCommand = false;
  let commandTail = Promise.resolve();
  const title = (ctx: ExtensionContext, state: TitleState): void => {
    if (ctx.hasUI) ctx.ui.setTitle(formatTitle(state, branch === undefined ? "unknown" : branch));
  };
  const request = async (message: Request, signal: AbortSignal): Promise<Extract<Response, { ok: true }>> => {
    const reply = await deps.request(message, signal);
    signal.throwIfAborted();
    if (!reply.ok) throw new Error(reply.error.message);
    if (reply.op !== message.op) throw new Error("Supervisor response operation mismatch");
    return reply;
  };
  async function refresh(ctx: ExtensionContext): Promise<void> {
    const current = ++revision;
    const session = lifetime;
    try {
      const git = deps.git(ctx);
      await git.prepare(session.signal);
      const state = await git.state(session.signal);
      if (current !== revision || session.signal.aborted || activeCommand || !ctx.isIdle()) return;
      branch = state.branch;
      title(ctx, state.status === "conflict" ? "conflict" : state.status === "merged" ? "merged" : "attention");
    } catch {
      if (current === revision && !session.signal.aborted && !activeCommand) title(ctx, "attention");
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    lifetime.abort();
    lifetime = new AbortController();
    activeCommand = false;
    branch = undefined;
    title(ctx, "starting");
    if (ctx.hasUI) await refresh(ctx);
  });
  pi.on("agent_start", (_event, ctx) => { revision++; title(ctx, "working"); });
  pi.on("agent_settled", async (_event, ctx) => { if (ctx.hasUI && !activeCommand) await refresh(ctx); });
  pi.on("session_shutdown", async () => { revision++; lifetime.abort(); await commandTail; });

  function command(name: string, description: string,
    handler: (args: string, ctx: ExtensionCommandContext, signal: AbortSignal) => Promise<void>): void {
    pi.registerCommand(name, { description, handler: (args, ctx) => {
      const session = lifetime;
      const job = commandTail.then(async () => {
        if (!ctx.hasUI || session.signal.aborted) return;
        revision++;
        activeCommand = true;
        try { await handler(args, ctx, session.signal); }
        catch (error) {
          if (!session.signal.aborted) {
            title(ctx, "failed");
            ctx.ui.notify(plainText(error instanceof Error ? error.message : "Worktree command failed", 2000), "error");
          }
        } finally { activeCommand = false; }
      });
      commandTail = job.catch(() => {});
      return job;
    } });
  }
  const noArgs = (args: string): void => { if (args.trim()) throw new Error("This command takes no arguments"); };
  const idle = (ctx: ExtensionContext): void => { if (!ctx.isIdle()) throw new Error("Wait for the current agent to settle before changing Git state"); };

  command("worktree", "Create or reopen a worktree in a new Kitty tab", async (args, ctx, signal) => {
    if (!args) throw new Error("Usage: /worktree <local-branch>");
    assertBranchName(args);
    const reply = await request({ version: 1, op: "create-or-open", branch: args }, signal);
    if (reply.op === "create-or-open") ctx.ui.notify(`${reply.outcome}: ${plainText(reply.worktree.path)}`, "info");
  });
  command("worktrees", "List Git worktrees and open a selected closed one", async (args, ctx, signal) => {
    noArgs(args);
    const reply = await request({ version: 1, op: "list" }, signal);
    if (reply.op !== "list") return;
    const choices = reply.worktrees.map((item, index) => [
      `${index + 1}. ${plainText(item.branch ?? "(detached)")}`, plainText(item.path),
      plainText(item.upstream?.ref ?? "no upstream"), item.head?.slice(0, 10) ?? "?", item.open ? "open" : "closed",
      item.inspection === "ok" ? item.status : `unavailable: ${plainText(item.error)}`,
      item.locked ? `git-locked: ${plainText(item.lockReason ?? "")}` : "",
      item.prunable ? `prunable: ${plainText(item.pruneReason ?? "")}` : "",
    ].filter(Boolean).join(" | "));
    const choice = await ctx.ui.select("Git worktrees", choices, { signal });
    if (choice === undefined || signal.aborted) return;
    const index = choices.indexOf(choice);
    const selected = reply.worktrees[index];
    if (!selected) return;
    const opened = await request({ version: 1, op: "open", worktreeId: selected.id }, signal);
    if (opened.op === "open") ctx.ui.notify(`${opened.outcome}: ${plainText(opened.worktree.path)}`, "info");
  });
  command("worktree-done", "Mark committed, conflict-free work done (Git checks only)", async (args, ctx, signal) => {
    noArgs(args); idle(ctx);
    const state = await deps.git(ctx).done(signal);
    signal.throwIfAborted();
    branch = state.branch;
    title(ctx, "done");
    ctx.ui.notify("Done: clean and committed. No project tests were run.", "info");
  });
  command("worktree-sync", "Merge the local parent branch into this task", async (args, ctx, signal) => {
    noArgs(args); idle(ctx);
    title(ctx, "working");
    const result = await deps.git(ctx).sync(signal);
    signal.throwIfAborted();
    branch = result.state.branch;
    title(ctx, result.conflict ? "conflict" : "attention");
    ctx.ui.notify(result.conflict ? "Conflicts remain in this task. Resolve and commit them here; the target is unchanged." : "Synced with the local parent. No project tests were run.", result.conflict ? "warning" : "info");
  });
  command("worktree-merge", "Fast-forward this target from a clean task branch", async (args, ctx, signal) => {
    idle(ctx); assertBranchName(args);
    const listed = await request({ version: 1, op: "list" }, signal);
    if (listed.op !== "list") return;
    const tasks = listed.worktrees.filter((item) => item.branch === args);
    if (tasks.length !== 1) throw new Error("Select a task branch with exactly one linked worktree");
    title(ctx, "working");
    const state = await deps.git(ctx).integrate(args, async () => {
      const inspected = await request({ version: 1, op: "inspect", worktreeId: tasks[0]!.id }, signal);
      if (inspected.op !== "inspect") throw new Error("Expected task inspection");
      return taskState(inspected.worktree);
    }, signal);
    signal.throwIfAborted();
    branch = state.branch;
    title(ctx, "merged");
    ctx.ui.notify("Target fast-forwarded. Task branch/worktree preserved; no project tests were run.", "info");
  });
}

export default function worktreeExtension(pi: ExtensionAPI): void {
  installWorktreeExtension(pi, {
    git: mountedGit,
    request: (request, signal) => requestSupervisor(process.env.PI_WORKTREE_SOCKET ?? "", request, { signal, timeoutMs: 600000 }),
  });
}
