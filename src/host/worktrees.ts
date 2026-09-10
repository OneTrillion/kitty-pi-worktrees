import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GitState } from "../shared/git-state.ts";
import type { HelperRequest } from "../shared/helper.ts";
import { RequestSchema, type Request, type Response, type Worktree } from "../shared/protocol.ts";
import { plainText } from "../shared/title.ts";
import { hasErrorCode } from "../shared/validation.ts";
import type { WorktreeRecord } from "../shared/worktree-records.ts";
import { validateBranchName } from "./branch.ts";
import type { HostConfig } from "./config.ts";
import type { DockerClient } from "./docker-client.ts";
import { containerName } from "./docker.ts";
import {
  discoverCurrentWorktree,
  isAuthorizedWorktree,
  listGitWorktrees,
  localBranchExists,
  locateGit,
} from "./git-discovery.ts";
import { runHelper, withRepositoryLock } from "./git-helper.ts";
import { launchInKitty } from "./kitty.ts";
import { isWorktreeOpen } from "./lock.ts";
import { deriveWorktreePath, worktreeId } from "./paths.ts";

type ErrorCode = Extract<Response, { ok: false }>["error"]["code"];
class RequestError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
export interface WorktreeServiceOptions {
  configPath?: string;
  user?: { uid: number; gid: number };
  // Trusted test adapters. Production always uses isolated Git helpers and Kitty launch.
  helper?: (request: HelperRequest, signal?: AbortSignal) => Promise<GitState | null>;
  launch?: (path: string, branch: string | null, signal?: AbortSignal) => Promise<void>;
  startupTimeoutMs?: number;
}

export const createWorktreeService = (
  config: HostConfig,
  sourcePath: string,
  docker: DockerClient,
  options: WorktreeServiceOptions = {},
) => {
  const helper =
    options.helper ?? ((request, signal) => runHelper(config, docker, request, signal, options.user));
  const launch =
    options.launch ??
    (async (path, branch, signal) => {
      if (!options.configPath) throw new Error("Host config path missing; start through the host CLI");
      await launchInKitty(config, options.configPath, path, branch, signal);
    });

  const inspect = async (record: WorktreeRecord, signal?: AbortSignal): Promise<Worktree> => {
    const base = { ...record, id: worktreeId(record.path), upstream: null, open: false };
    try {
      if (!isAuthorizedWorktree(config, record.path))
        throw new Error("Outside the configured host worktree paths");
      const location = await locateGit(config, record.path);
      base.open = await isWorktreeOpen(config.runtimeRoot, record.path);
      if (!base.open && (await docker.lookup(containerName(record.path))))
        throw new Error("Leftover container; use the host recover command before opening/integrating");
      const state = await helper({ op: "inspect", location }, signal);
      if (!state) throw new Error("Git helper returned no inspection");
      return { ...base, ...state, inspection: "ok" };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ...base,
        inspection: "unavailable",
        error: plainText(error instanceof Error ? error.message : "Inspection unavailable", 2000),
      };
    }
  };

  const open = async (
    record: WorktreeRecord,
    signal?: AbortSignal,
  ): Promise<{ outcome: "reopened" | "already-active"; worktree: Worktree }> => {
    const worktree = await inspect(record, signal);
    if (worktree.open) return { outcome: "already-active", worktree }; // Never focus/modify an existing tab.
    if (worktree.inspection === "unavailable") throw new RequestError("unavailable", worktree.error);
    signal?.throwIfAborted();
    try {
      await launch(record.path, record.branch, signal);
    } catch (error) {
      throw new RequestError(
        "kitty-error",
        `${error instanceof Error ? error.message : "Kitty launch failed"}. Worktree preserved at ${record.path}; cd there and use the host start command`,
      );
    }
    // Hold the repository operation lock across launch handoff, not a task registry.
    // The child supervisor can acquire its lifetime lock without this repository lock.
    const deadline = Date.now() + (options.startupTimeoutMs ?? 15000);
    while (!(await isWorktreeOpen(config.runtimeRoot, record.path))) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline)
        throw new RequestError(
          "unavailable",
          "Kitty accepted the tab but startup was not confirmed. Check the new tab before retrying; the worktree is preserved",
        );
      await delay(100, undefined, signal ? { signal } : {});
    }
    return { outcome: "reopened", worktree: { ...worktree, open: true } };
  };

  const dispatch = async (request: Request, signal?: AbortSignal): Promise<Response> => {
    const records = await listGitWorktrees(config, signal);
    if (request.op === "list") {
      const worktrees: Worktree[] = [];
      for (const record of records) {
        signal?.throwIfAborted();
        worktrees.push(await inspect(record, signal));
      }
      return { version: 1, ok: true, op: "list", worktrees };
    }
    if (request.op === "open" || request.op === "inspect") {
      const record = records.find((item) => worktreeId(item.path) === request.worktreeId);
      if (!record) throw new RequestError("not-found", "Worktree no longer exists; refresh the list");
      if (request.op === "inspect")
        return { version: 1, ok: true, op: "inspect", worktree: await inspect(record, signal) };
      return { version: 1, ok: true, op: "open", ...(await open(record, signal)) };
    }
    await validateBranchName(request.branch); // Before any filesystem creation or Kitty operation.
    const matches = records.filter((item) => item.branch === request.branch);
    if (matches.length > 1)
      throw new RequestError(
        "git-error",
        "Branch is checked out in multiple worktrees; resolve this Git state explicitly",
      );
    if (matches[0])
      return { version: 1, ok: true, op: "create-or-open", ...(await open(matches[0], signal)) };
    const source = await discoverCurrentWorktree(config, sourcePath, signal);
    if (!source.branch && !(await localBranchExists(config, request.branch, signal)))
      throw new RequestError(
        "git-error",
        "Cannot create a task from detached HEAD; check out a local source branch first",
      );
    const path = deriveWorktreePath(config.worktreeRoot, request.branch);
    try {
      await mkdir(path);
    } catch (cause) {
      if (hasErrorCode(cause, "EEXIST"))
        throw new RequestError(
          "path-collision",
          `Destination already exists: ${path}. Nothing was overwritten`,
        );
      throw cause;
    }
    // Only this new empty directory (not its host parent) is bound into the helper.
    // Errors preserve any created branch/worktree/directory; no destructive rollback.
    try {
      await helper(
        {
          op: "create",
          branch: request.branch,
          destination: path,
          location: {
            worktreePath: config.repositoryPath,
            gitDir: join(config.repositoryPath, ".git"),
            commonGitDir: join(config.repositoryPath, ".git"),
          },
          source: { branch: source.branch, head: source.head },
        },
        signal,
      );
    } catch (error) {
      throw new RequestError(
        "git-error",
        `${error instanceof Error ? error.message : "Git creation failed"}. Inspect preserved branch/worktree state and destination ${path} before retrying`,
      );
    }
    const created = (await listGitWorktrees(config, signal)).find(
      (item) => item.path === path && item.branch === request.branch,
    );
    if (!created)
      throw new RequestError(
        "git-error",
        "Git did not report the new worktree; inspect its preserved state on the host",
      );
    const opened = await open(created, signal);
    return { version: 1, ok: true, op: "create-or-open", outcome: "created", worktree: opened.worktree };
  };

  return {
    async handle(input: Request, signal?: AbortSignal): Promise<Response> {
      try {
        const parsed = RequestSchema.safeParse(input);
        if (!parsed.success) throw new RequestError("invalid-request", "Invalid worktree request");
        return await withRepositoryLock(config, () => dispatch(parsed.data, signal), signal);
      } catch (error) {
        return {
          version: 1,
          ok: false,
          error: {
            code: error instanceof RequestError ? error.code : "git-error",
            message:
              plainText(error instanceof Error ? error.message : "Host operation failed", 4000) ||
              "Host operation failed",
          },
        };
      }
    },
  };
};
