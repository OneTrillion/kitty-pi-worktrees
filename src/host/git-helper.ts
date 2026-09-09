import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostConfig } from "./config.ts";
import type { DockerClient } from "./docker-client.ts";
import { cleanupContainer, owned, ROLE_LABEL } from "./container-cleanup.ts";
import { MANAGED_LABEL, REPOSITORY_LABEL, RUN_LABEL, RUN_ID_PATTERN, WORKTREE_LABEL, validateDirectoryMount } from "./docker.ts";
import { acquireWorktreeLock, WorktreeBusyError } from "./lock.ts";
import { worktreeId } from "./paths.ts";
import { isAuthorizedWorktree, locateGit } from "./git-discovery.ts";
import { pinMountDirectories } from "./mount-identity.ts";
import { HelperReplySchema, HelperRequestSchema, type HelperRequest } from "../shared/helper.ts";

export function gitHelperName(config: HostConfig): string {
  return `pi-worktree-git-${worktreeId(join(config.repositoryPath, ".git"))}`;
}

/** Separate from lifetime task locks; OS-released, no PID/JSON registry. */
export async function withRepositoryLock<T>(config: HostConfig, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    let lock;
    try { lock = await acquireWorktreeLock(config.runtimeRoot, join(config.repositoryPath, ".git")); }
    catch (error) {
      if (!(error instanceof WorktreeBusyError)) throw error;
      await delay(50, undefined, signal ? { signal } : {});
      continue;
    }
    try { signal?.throwIfAborted(); return await action(); }
    finally { await lock.release(); }
  }
}

export function gitHelperArgs(config: HostConfig, request: HelperRequest, runId: string, user: { uid: number; gid: number }): string[] {
  HelperRequestSchema.parse(request);
  if (!RUN_ID_PATTERN.test(runId) || [user.uid, user.gid].some((id) => !Number.isSafeInteger(id) || id < 1 || id > 0xfffffffe)) {
    throw new Error("Git helpers require a valid run ID and non-root UID/GID");
  }
  const common = join(config.repositoryPath, ".git");
  if (request.location.commonGitDir !== common) throw new Error("Helper common Git directory mismatch");
  const path = request.op === "inspect" ? request.location.worktreePath : request.destination;
  if (!isAuthorizedWorktree(config, request.location.worktreePath) ||
      (request.op === "create" && (dirname(path) !== config.worktreeRoot ||
        request.location.worktreePath !== config.repositoryPath || request.location.gitDir !== common))) {
    throw new Error("Helper paths are outside the configured worktree policy");
  }
  validateDirectoryMount(path);
  validateDirectoryMount(common);
  const readonly = request.op === "inspect" ? ",readonly" : "";
  // Crucially, creation receives the PRECREATED destination only, never its parent
  // nor the source worktree's files. Git's common directory parent exists in the
  // container only to house that bind mount, not as a bind of host source files.
  return ["create", "--pull=never", "--restart=no", "--init", "--read-only", "--network=none",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${user.uid}:${user.gid}`,
    "--name", gitHelperName(config),
    "--label", `${MANAGED_LABEL}=1`, "--label", `${ROLE_LABEL}=git`,
    "--label", `${WORKTREE_LABEL}=${worktreeId(config.repositoryPath)}`,
    "--label", `${REPOSITORY_LABEL}=${worktreeId(common)}`, "--label", `${RUN_LABEL}=${runId}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--workdir", "/tmp", "--env", "HOME=/tmp",
    "--mount", `type=bind,src=${path},dst=${path}${readonly}`,
    "--mount", `type=bind,src=${common},dst=${common}${readonly}`,
    "--entrypoint", "node", config.image, "/opt/pi-worktree/dist/git/worker-cli.js", JSON.stringify(request)];
}

/** Caller holds the repository lock until this returns, including any cleanup retries. */
export async function runHelper(config: HostConfig, docker: DockerClient, request: HelperRequest,
  signal?: AbortSignal, user = { uid: process.getuid!(), gid: process.getgid!() }) {
  signal?.throwIfAborted();
  const name = gitHelperName(config);
  if (await docker.lookup(name)) throw new Error("Git helper still exists; use host recover-git before retrying");
  const scope = { worktreePath: config.repositoryPath, commonGitDir: join(config.repositoryPath, ".git") };
  const runId = randomUUID();
  const args = gitHelperArgs(config, request, runId, user);
  const revalidateDirectories = await pinMountDirectories([config.repositoryPath, config.worktreeRoot,
    request.location.worktreePath, request.location.gitDir, request.location.commonGitDir,
    ...(request.op === "create" ? [request.destination] : [])]);
  const revalidate = async (): Promise<void> => {
    await revalidateDirectories();
    const current = await locateGit(config, request.location.worktreePath);
    if (current.gitDir !== request.location.gitDir || current.commonGitDir !== request.location.commonGitDir) {
      throw new Error("Git helper paths changed during startup");
    }
    signal?.throwIfAborted();
  };
  await revalidate();
  let id: string | undefined;
  try {
    const createdId = await docker.create(args);
    const info = await docker.lookup(createdId);
    if (!info || info.Name !== `/${name}` || !owned(info, scope, runId, "git")) throw new Error("Git helper identity was not verified");
    id = info.Id;
    await revalidate();
    const reply = HelperReplySchema.parse(JSON.parse(await docker.capture(id, signal)));
    if (!reply.ok) throw new Error(reply.error);
    return reply.state;
  } finally {
    await cleanupContainer(docker, scope, runId, id, 2000, console.error, { name, role: "git" });
  }
}

/** Explicit host-only recovery for a helper whose owner died. No task container is touched. */
export async function recoverGitHelper(config: HostConfig, docker: DockerClient): Promise<void> {
  const lock = await acquireWorktreeLock(config.runtimeRoot, join(config.repositoryPath, ".git"));
  try {
    const name = gitHelperName(config);
    const info = await docker.lookup(name);
    if (!info) return;
    const scope = { worktreePath: config.repositoryPath, commonGitDir: join(config.repositoryPath, ".git") };
    if (!owned(info, scope, undefined, "git")) throw new Error("Unrecognized container occupies the Git helper name");
    await cleanupContainer(docker, scope, info.Config.Labels![RUN_LABEL]!, info.Id, 2000, console.error, { name, role: "git" });
  } finally { await lock.release(); }
}
