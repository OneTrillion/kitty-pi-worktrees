import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  failureResponse,
  PROTOCOL_VERSION,
  RequestSchema,
  type Request,
  type Response,
  type Worktree,
} from "../shared/protocol.ts";
import { plainText } from "../shared/title.ts";
import { hasErrorCode } from "../shared/validation.ts";
import { validateBranchName } from "./branch.ts";
import type { HostConfig } from "./config.ts";
import type { DockerClient } from "./docker-client.ts";
import { discoverCurrentWorktree, listGitWorktrees, localBranchExists } from "./git-discovery.ts";
import { withRepositoryLock } from "./git-helper.ts";
import { deriveWorktreePath, worktreeId } from "./paths.ts";
import { createWorktreeSession, type WorktreeServiceOptions } from "./worktree-session.ts";

export const createWorktreeService = (
  config: HostConfig,
  sourcePath: string,
  docker: DockerClient,
  options: WorktreeServiceOptions = {},
) => {
  const { helper, inspect, open } = createWorktreeSession(config, docker, options);
  const version = PROTOCOL_VERSION;

  const dispatch = async (request: Request, signal?: AbortSignal): Promise<Response> => {
    const records = await listGitWorktrees(config, signal);
    if (request.op === "list") {
      const worktrees: Worktree[] = [];
      for (const record of records) worktrees.push(await inspect(record, signal));
      return { version, ok: true, op: "list", worktrees };
    }
    if (request.op === "open" || request.op === "inspect") {
      const record = records.find((item) => worktreeId(item.path) === request.worktreeId);
      if (!record) return failureResponse("not-found", "Worktree no longer exists; refresh the list");
      if (request.op === "inspect")
        return { version, ok: true, op: "inspect", worktree: await inspect(record, signal) };
      const opened = await open(record, signal);
      return opened.ok ? { version, op: "open", ...opened } : opened;
    }
    await validateBranchName(request.branch); // Before filesystem creation or Kitty operations.
    const matches = records.filter((item) => item.branch === request.branch);
    if (matches.length > 1)
      return failureResponse(
        "git-error",
        "Branch is checked out in multiple worktrees; resolve this Git state explicitly",
      );
    if (matches[0]) {
      const opened = await open(matches[0], signal);
      return opened.ok ? { version, op: "create-or-open", ...opened } : opened;
    }
    const source = await discoverCurrentWorktree(config, sourcePath, signal);
    if (!source.branch && !(await localBranchExists(config, request.branch, signal)))
      return failureResponse(
        "git-error",
        "Cannot create a task from detached HEAD; check out a local source branch first",
      );
    const path = deriveWorktreePath(config.worktreeRoot, request.branch);
    signal?.throwIfAborted();
    try {
      await mkdir(path);
    } catch (cause) {
      if (hasErrorCode(cause, "EEXIST"))
        return failureResponse(
          "path-collision",
          `Destination already exists: ${path}. Nothing was overwritten`,
        );
      throw cause;
    }
    // Bind only this new empty directory, never its host parent. Preserve partial state on failure.
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
      return failureResponse(
        "git-error",
        plainText(
          `${error instanceof Error ? error.message : "Git creation failed"}. Inspect preserved branch/worktree state and destination ${path} before retrying`,
          4000,
        ),
      );
    }
    const created = (await listGitWorktrees(config, signal)).find(
      (item) => item.path === path && item.branch === request.branch,
    );
    if (!created)
      return failureResponse(
        "git-error",
        "Git did not report the new worktree; inspect its preserved state on the host",
      );
    const opened = await open(created, signal);
    return opened.ok
      ? { version, ok: true, op: "create-or-open", outcome: "created", worktree: opened.worktree }
      : opened;
  };

  const handle = async (input: unknown, signal?: AbortSignal): Promise<Response> => {
    const parsed = RequestSchema.safeParse(input);
    if (!parsed.success) return failureResponse("invalid-request", "Invalid worktree request");
    try {
      return await withRepositoryLock(config, () => dispatch(parsed.data, signal), signal);
    } catch (error) {
      return failureResponse(
        "git-error",
        plainText(error instanceof Error ? error.message : "Host operation failed", 4000) ||
          "Host operation failed",
      );
    }
  };

  return { handle };
};
