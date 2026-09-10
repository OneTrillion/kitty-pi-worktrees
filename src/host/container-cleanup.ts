import { setTimeout as delay } from "node:timers/promises";
import type { ContainerInfo, DockerClient } from "./docker-client.ts";
import {
  containerName,
  MANAGED_LABEL,
  REPOSITORY_LABEL,
  RUN_ID_PATTERN,
  RUN_LABEL,
  WORKTREE_LABEL,
} from "./docker.ts";
import { worktreeId } from "./paths.ts";

export const ROLE_LABEL = "io.pi-worktree.role";
type Scope = { worktreePath: string; commonGitDir: string };
type OwnedContainer = ContainerInfo & {
  Config: { Labels: Record<string, string> & { [RUN_LABEL]: string } };
};

export const owned = (
  info: ContainerInfo,
  scope: Scope,
  runId?: string,
  role?: "git",
): info is OwnedContainer => {
  const labels = info.Config.Labels;
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels[WORKTREE_LABEL] === worktreeId(scope.worktreePath) &&
    labels[REPOSITORY_LABEL] === worktreeId(scope.commonGitDir) &&
    typeof labels[RUN_LABEL] === "string" &&
    RUN_ID_PATTERN.test(labels[RUN_LABEL]) &&
    (runId === undefined || labels[RUN_LABEL] === runId) &&
    (role === undefined || labels[ROLE_LABEL] === role)
  );
};

/** Unknown daemon state must not release a lock while a writer might survive. */
export const cleanupContainer = async (
  docker: DockerClient,
  scope: Scope,
  runId: string,
  id: string | undefined,
  retryMs: number,
  notice: (message: string) => void,
  options: { name?: string; role?: "git" } = {},
): Promise<void> => {
  let warned = false;
  for (;;) {
    try {
      const info = await docker.lookup(id ?? options.name ?? containerName(scope.worktreePath));
      if (!info) return;
      if (!owned(info, scope, runId, options.role)) {
        if (!id) return;
        throw new Error("Container ownership changed unexpectedly");
      }
      id = info.Id;
      if (info.State.Running || info.State.Restarting || info.State.Paused) await docker.stop(id);
      await docker.remove(id);
      if (await docker.lookup(id)) throw new Error("Container removal has not been confirmed");
      return;
    } catch {
      if (!warned) {
        try {
          notice(
            "Docker cleanup is unconfirmed; retaining the worktree lock and retrying. Restore Docker access; SIGKILL will require host recovery.",
          );
        } catch {
          /* Reporting is noncritical. */
        }
        warned = true;
      }
      await delay(retryMs);
    }
  }
};
