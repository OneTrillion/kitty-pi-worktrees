import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitOperations } from "../git/operations.ts";
import type { Request, Response } from "../shared/protocol.ts";

export type WorktreeContext = Pick<ExtensionContext, "cwd" | "hasUI" | "isIdle"> & {
  ui: Pick<ExtensionContext["ui"], "setTitle" | "notify" | "select">;
};

export type CommandHandler = (args: string, ctx: WorktreeContext, signal: AbortSignal) => Promise<void>;

type LifecycleEvent = "session_start" | "agent_start" | "agent_settled" | "session_shutdown";

/** Only the Pi capabilities this extension uses; no tools or persistent entries. */
export interface WorktreeExtensionAPI {
  on(event: LifecycleEvent, handler: (event: unknown, ctx: WorktreeContext) => void | Promise<void>): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: WorktreeContext) => Promise<void>;
    },
  ): void;
}

export interface ExtensionDependencies {
  git: (ctx: WorktreeContext) => Pick<GitOperations, "prepare" | "state" | "done" | "sync" | "integrate">;
  request: (request: Request, signal: AbortSignal) => Promise<Response>;
}
