import { setTimeout as delay } from "node:timers/promises";
import type { GitState } from "../shared/git-state.ts";
import type { HelperRequest } from "../shared/helper.ts";
import { failureResponse, type FailureResponse, type Worktree } from "../shared/protocol.ts";
import { plainText } from "../shared/title.ts";
import type { WorktreeRecord } from "../shared/worktree-records.ts";
import type { HostConfig } from "./config.ts";
import type { DockerClient } from "./docker-client.ts";
import { containerName } from "./docker.ts";
import { isAuthorizedWorktree, locateGit } from "./git-discovery.ts";
import { runHelper } from "./git-helper.ts";
import { launchInKitty } from "./kitty.ts";
import { isWorktreeOpen } from "./lock.ts";
import { worktreeId } from "./paths.ts";

export interface WorktreeServiceOptions {
  configPath?: string;
  user?: { uid: number; gid: number };
  // Trusted test adapters. Production uses isolated Git helpers and Kitty launch.
  helper?: (request: HelperRequest, signal?: AbortSignal) => Promise<GitState | null>;
  launch?: (path: string, branch: string | null, signal?: AbortSignal) => Promise<void>;
  startupTimeoutMs?: number;
}

type OpenResult = { ok: true; outcome: "reopened" | "already-active"; worktree: Worktree } | FailureResponse;

/** Live inspection and new-tab handoff; the caller holds the repository operation lock. */
export const createWorktreeSession = (
  config: HostConfig,
  docker: DockerClient,
  options: WorktreeServiceOptions,
) => {
  const startupTimeoutMs = options.startupTimeoutMs ?? 15000;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1)
    throw new Error("Invalid startup timeout");
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
      signal?.throwIfAborted();
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
        error:
          plainText(error instanceof Error ? error.message : "Inspection unavailable", 2000).trim() ||
          "Inspection unavailable",
      };
    }
  };

  const open = async (record: WorktreeRecord, signal?: AbortSignal): Promise<OpenResult> => {
    const worktree = await inspect(record, signal);
    // Never focus or modify an existing tab, even when its Git inspection failed.
    if (worktree.open) return { ok: true, outcome: "already-active", worktree };
    if (worktree.inspection === "unavailable") return failureResponse("unavailable", worktree.error);
    signal?.throwIfAborted();
    try {
      await launch(record.path, record.branch, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return failureResponse(
        "kitty-error",
        plainText(
          `${error instanceof Error ? error.message : "Kitty launch failed"}. Worktree preserved at ${record.path}; cd there and use the host start command`,
          4000,
        ),
      );
    }
    // The child supervisor can acquire its lifetime lock while we hold the repository lock.
    const deadline = Date.now() + startupTimeoutMs;
    while (!(await isWorktreeOpen(config.runtimeRoot, record.path))) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline)
        return failureResponse(
          "unavailable",
          "Kitty accepted the tab but startup was not confirmed. Check the new tab before retrying; the worktree is preserved",
        );
      await delay(100, undefined, signal ? { signal } : {});
    }
    return { ok: true, outcome: "reopened", worktree: { ...worktree, open: true } };
  };

  return { helper, inspect, open };
};
