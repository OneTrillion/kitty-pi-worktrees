import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, normalize } from "node:path";
import { createGitOperations, type GitOperations } from "../git/operations.ts";
import { requestSupervisor } from "../shared/client.ts";
import { registerWorktreeCommands } from "./commands.ts";
import { createExtensionSession } from "./session.ts";
import type { ExtensionDependencies, WorktreeContext, WorktreeExtensionAPI } from "./types.ts";

const mountedGit = (ctx: WorktreeContext): GitOperations => {
  const root = process.env.PI_WORKTREE_ROOT;
  const gitDir = process.env.PI_WORKTREE_GIT_DIR;
  const commonGitDir = process.env.PI_WORKTREE_COMMON_GIT_DIR;
  if (
    !process.env.PI_WORKTREE_SOCKET ||
    !root ||
    !gitDir ||
    !commonGitDir ||
    [root, gitDir, commonGitDir].some((path) => !isAbsolute(path) || normalize(path) !== path) ||
    ctx.cwd !== root ||
    !(gitDir === commonGitDir || gitDir.startsWith(commonGitDir + "/"))
  ) {
    throw new Error(
      "Launch Pi through the worktree supervisor in its selected worktree; Git commands are container-only",
    );
  }
  return createGitOperations({ worktreePath: root, gitDir, commonGitDir });
};

/** Registration only. All I/O starts in lifecycle or command handlers. */
export const installWorktreeExtension = (pi: WorktreeExtensionAPI, deps: ExtensionDependencies): void => {
  registerWorktreeCommands(createExtensionSession(pi, deps), deps);
};

const worktreeExtension = (pi: WorktreeExtensionAPI): void => {
  installWorktreeExtension(pi, {
    git: mountedGit,
    request: (request, signal) =>
      requestSupervisor(process.env.PI_WORKTREE_SOCKET ?? "", request, { signal, timeoutMs: 600000 }),
  });
};

export default worktreeExtension satisfies (pi: ExtensionAPI) => void;
