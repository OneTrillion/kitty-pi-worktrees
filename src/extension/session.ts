import { formatTitle, plainText, type TitleState } from "../shared/title.ts";
import type {
  CommandHandler,
  ExtensionDependencies,
  WorktreeContext,
  WorktreeExtensionAPI,
} from "./types.ts";

/** Serializes commands and owns transient UI state for one extension instance. */
export const createExtensionSession = (pi: WorktreeExtensionAPI, deps: ExtensionDependencies) => {
  let lifetime = new AbortController();
  let revision = 0;
  let branch: string | null | undefined;
  let activeCommand = false;
  let commandTail = Promise.resolve();

  const title = (ctx: WorktreeContext, state: TitleState, currentBranch = branch): void => {
    branch = currentBranch;
    if (ctx.hasUI) ctx.ui.setTitle(formatTitle(state, branch === undefined ? "unknown" : branch));
  };

  const refresh = async (ctx: WorktreeContext): Promise<void> => {
    const current = ++revision;
    const session = lifetime;
    try {
      const git = deps.git(ctx);
      await git.prepare(session.signal);
      const state = await git.state(session.signal);
      // An older read must not overwrite a newer command or agent lifecycle event.
      if (current !== revision || session.signal.aborted || activeCommand || !ctx.isIdle()) return;
      title(
        ctx,
        state.status === "conflict" ? "conflict" : state.status === "merged" ? "merged" : "attention",
        state.branch,
      );
    } catch {
      if (current === revision && !session.signal.aborted && !activeCommand) title(ctx, "attention");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    lifetime.abort();
    lifetime = new AbortController();
    activeCommand = false;
    branch = undefined;
    title(ctx, "starting");
    if (ctx.hasUI) await refresh(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    revision++;
    title(ctx, "working");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.hasUI && !activeCommand) await refresh(ctx);
  });
  pi.on("session_shutdown", async () => {
    revision++;
    lifetime.abort();
    await commandTail;
  });

  const command = (name: string, description: string, handler: CommandHandler): void => {
    pi.registerCommand(name, {
      description,
      handler: (args, ctx) => {
        const session = lifetime;
        const job = commandTail.then(async () => {
          if (!ctx.hasUI || session.signal.aborted) return;
          revision++;
          activeCommand = true;
          try {
            await handler(args, ctx, session.signal);
          } catch (error) {
            if (!session.signal.aborted) {
              title(ctx, "failed");
              ctx.ui.notify(
                plainText(error instanceof Error ? error.message : "Worktree command failed", 2000),
                "error",
              );
            }
          } finally {
            activeCommand = false;
          }
        });
        commandTail = job.catch(() => {});
        return job;
      },
    });
  };

  return { command, title };
};
