import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import type { HostConfig } from "./config.ts";
import { cleanupContainer, owned } from "./container-cleanup.ts";
import { createDockerClient, type AttachedContainer, type DockerClient } from "./docker-client.ts";
import { containerName, dockerCreateArgs, RUN_LABEL } from "./docker.ts";
import { discoverCurrentWorktree, type DiscoveredWorktree } from "./git-discovery.ts";
import { gitHelperName } from "./git-helper.ts";
import { acquireWorktreeLock } from "./lock.ts";
import { pinMountDirectories } from "./mount-identity.ts";
import { createRuntimeDirectory, getHostUser, prepareRuntimeRoot } from "./runtime.ts";
import { startRequestServer } from "./server.ts";
import { createWorktreeService } from "./worktrees.ts";

interface SupervisorOptions {
  signal?: AbortSignal;
  onNotice?: (message: string) => void;
  // Trusted test seams, deliberately not CLI/config/request options.
  dockerFactory?: typeof createDockerClient;
  containerUser?: { uid: number; gid: number };
  cleanupRetryMs?: number;
  configPath?: string;
}

const waitForExit = async (attachment: AttachedContainer, signal: AbortSignal): Promise<number> => {
  return new Promise<number>((resolve, reject) => {
    const abort = (): void => resolve(130);
    signal.addEventListener("abort", abort, { once: true });
    // Attach both handlers immediately, even if cancellation already happened.
    void attachment.completion
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
};

/** One call per host process/tab; container requests are delegated to the narrow worktree service. */
export const runHostSession = async (
  config: HostConfig,
  cwd: string,
  mode: "start" | "recover",
  options: SupervisorOptions = {},
): Promise<number> => {
  const retryMs = options.cleanupRetryMs ?? 2000;
  if (!Number.isSafeInteger(retryMs) || retryMs < 1) throw new Error("Invalid cleanup retry interval");
  const shutdown = new AbortController();
  let shutdownCode: number | undefined;
  let fatal: Error | undefined;
  const notice = (message: string): void => {
    try {
      (options.onNotice ?? console.error)(message);
    } catch {
      /* Reporting must not interrupt cleanup. */
    }
  };
  const signals = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  const listeners = Object.entries(signals).map(([signal, code]) => {
    const listener = (): void => {
      shutdownCode ??= code;
      shutdown.abort();
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  const cancel = (): void => {
    shutdownCode ??= 130;
    shutdown.abort();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();

  let lock: Awaited<ReturnType<typeof acquireWorktreeLock>> | undefined;
  let server: Awaited<ReturnType<typeof startRequestServer>> | undefined;
  let control: Awaited<ReturnType<typeof createRuntimeDirectory>> | undefined;
  let docker: DockerClient | undefined;
  let location: DiscoveredWorktree | undefined;
  let attachment: AttachedContainer | undefined;
  let cleanupNeeded = false;
  let containerId: string | undefined;
  let runId: string = randomUUID();
  let exitCode = 0;
  let failure: unknown;
  try {
    const hostUser = getHostUser();
    const user = options.containerUser ?? hostUser;
    if (mode === "start" && (user.uid < 1 || user.gid < 1))
      throw new Error("Start Pi from a non-root host account");
    location = await discoverCurrentWorktree(config, cwd, shutdown.signal);
    const revalidateDirectories = await pinMountDirectories([
      config.repositoryPath,
      config.worktreeRoot,
      location.worktreePath,
      location.commonGitDir,
      location.gitDir,
    ]);
    await prepareRuntimeRoot(config.runtimeRoot);
    lock = await acquireWorktreeLock(config.runtimeRoot, location.worktreePath);
    if (lock.canonicalPath !== location.worktreePath)
      throw new Error("Worktree changed during lock acquisition");
    control = await createRuntimeDirectory(config.runtimeRoot);
    docker = await (options.dockerFactory ?? createDockerClient)(config, control.directory);
    shutdown.signal.throwIfAborted();

    const existing = await docker.lookup(containerName(location.worktreePath));
    if (mode === "recover") {
      if (existing) {
        if (!owned(existing, location))
          throw new Error("Container name is occupied by an unrecognized container; refusing recovery");
        containerId = existing.Id;
        runId = existing.Config.Labels[RUN_LABEL];
        cleanupNeeded = true; // The explicit host recover command authorizes stop/removal of this ID.
        notice(`Recovering managed container ${containerId}`);
      } else notice("No leftover container for this worktree");
    } else {
      if (existing)
        throw new Error(
          `Container ${existing.Id} already occupies this worktree name. Inspect it on the host; use recover for a verified managed leftover.`,
        );
      if (await docker.lookup(gitHelperName(config)))
        throw new Error(
          "A repository Git helper is active or left over. Wait for the operation, or use host recover-git if its owner died",
        );
      const service = createWorktreeService(config, location.worktreePath, docker, {
        user,
        ...(options.configPath ? { configPath: options.configPath } : {}),
      });
      server = await startRequestServer(config.runtimeRoot, (request, signal) =>
        service.handle(request, signal),
      );
      void server.failure.then((error) => {
        fatal = error;
        shutdown.abort();
      });
      const socketPin = await lstat(server.socketPath, { bigint: true });
      const socketPath = server.socketPath;
      const mounted = location;
      const revalidate = async (): Promise<void> => {
        const current = await discoverCurrentWorktree(config, mounted.worktreePath, shutdown.signal);
        if (
          current.worktreePath !== mounted.worktreePath ||
          current.gitDir !== mounted.gitDir ||
          current.commonGitDir !== mounted.commonGitDir
        ) {
          throw new Error("Git worktree paths changed during startup");
        }
        await revalidateDirectories();
        const socket = await lstat(socketPath, { bigint: true });
        if (
          !socket.isSocket() ||
          socket.uid !== BigInt(hostUser.uid) ||
          (socket.mode & 0o777n) !== 0o600n ||
          socket.dev !== socketPin.dev ||
          socket.ino !== socketPin.ino ||
          (await realpath(socketPath)) !== socketPath
        ) {
          throw new Error("Supervisor socket changed during startup");
        }
        shutdown.signal.throwIfAborted();
      };
      await revalidate();
      const args = dockerCreateArgs(config, { ...location, socketPath, ...user }, runId);
      cleanupNeeded = true; // A failed/timed-out create can leave a STOPPED container.
      const createdId = await docker.create(args);
      const created = await docker.lookup(createdId);
      if (
        !created ||
        !owned(created, location, runId) ||
        created.Name !== `/${containerName(location.worktreePath)}`
      ) {
        throw new Error("Created container identity could not be verified");
      }
      containerId = created.Id;
      await revalidate();
      attachment = docker.attach(containerId);
      exitCode = await waitForExit(attachment, shutdown.signal);
    }
  } catch (error) {
    if (!shutdown.signal.aborted) failure = error;
  } finally {
    // Stop accepting requests now. Docker control uses a separate private directory,
    // so removing the request socket cannot invalidate in-flight cleanup commands.
    const serverClosed = server?.close();
    // Install a rejection handler immediately; still await it before releasing the lock.
    void serverClosed?.catch(() => {});
    try {
      if (cleanupNeeded && docker && location)
        await cleanupContainer(docker, location, runId, containerId, retryMs, notice);
      await attachment?.disconnect();
    } finally {
      try {
        await serverClosed;
      } finally {
        try {
          await control?.remove();
        } finally {
          try {
            await lock?.release();
          } finally {
            for (const { signal, listener } of listeners) process.off(signal, listener);
            options.signal?.removeEventListener("abort", cancel);
          }
        }
      }
    }
  }
  if (fatal) throw fatal;
  if (failure) throw failure;
  return shutdownCode ?? exitCode;
};
