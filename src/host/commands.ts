import { PROTOCOL_VERSION, type Response } from "../shared/protocol.ts";
import type { HostConfig } from "./config.ts";
import { createDockerClient } from "./docker-client.ts";
import { listGitWorktrees } from "./git-discovery.ts";
import { recoverGitHelper } from "./git-helper.ts";
import { worktreeId } from "./paths.ts";
import { createRuntimeDirectory, prepareRuntimeRoot } from "./runtime.ts";
import type { WorktreeServiceOptions } from "./worktree-session.ts";
import { createWorktreeService } from "./worktrees.ts";

export const resolveSelection = async (config: HostConfig, selector: string): Promise<string> => {
  const records = await listGitWorktrees(config);
  const matches = records.filter(
    (item) =>
      item.branch === selector ||
      (/^[a-f0-9]{8,64}$/.test(selector) && worktreeId(item.path).startsWith(selector)),
  );
  const [selected] = matches;
  if (matches.length !== 1 || !selected)
    throw new Error("Select one existing worktree by branch or unambiguous ID from the host list command");
  return worktreeId(selected.path);
};

export const runHostCommand = async (
  config: HostConfig,
  configPath: string,
  command: "list" | "open" | "recover-git",
  selector?: string,
  // Trusted test adapters, never CLI/config/protocol fields.
  options: { dockerFactory?: typeof createDockerClient; service?: WorktreeServiceOptions } = {},
): Promise<Response | null> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, abort);
  let control: Awaited<ReturnType<typeof createRuntimeDirectory>> | undefined;
  try {
    await prepareRuntimeRoot(config.runtimeRoot);
    control = await createRuntimeDirectory(config.runtimeRoot);
    const docker = await (options.dockerFactory ?? createDockerClient)(config, control.directory);
    controller.signal.throwIfAborted();
    if (command === "recover-git") {
      await recoverGitHelper(config, docker);
      return null;
    }
    const service = createWorktreeService(config, config.repositoryPath, docker, {
      ...options.service,
      configPath,
    });
    return await service.handle(
      command === "list"
        ? { version: PROTOCOL_VERSION, op: "list" }
        : {
            version: PROTOCOL_VERSION,
            op: "open",
            worktreeId: await resolveSelection(config, selector ?? ""),
          },
      controller.signal,
    );
  } finally {
    // Handlers finish/clean up their helper before returning, including on cancellation.
    try {
      await control?.remove();
    } finally {
      for (const signal of signals) process.off(signal, abort);
    }
  }
};
