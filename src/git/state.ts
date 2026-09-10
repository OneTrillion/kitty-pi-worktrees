import { access } from "node:fs/promises";
import { join } from "node:path";
import { assertBranchName } from "../shared/branch.ts";
import { classifyState, type GitState } from "../shared/git-state.ts";
import type { GitLocation } from "../shared/helper.ts";
import { hasErrorCode } from "../shared/validation.ts";
import type { GitCommand } from "./command.ts";

export const createGitReader = (location: GitLocation, command: GitCommand) => {
  const readBranch = async (signal?: AbortSignal): Promise<string | null> => {
    const result = await command(["symbolic-ref", "--quiet", "HEAD"], signal, [0, 1]);
    if (result.code === 1) return null;
    const ref = result.stdout.trimEnd();
    if (!ref.startsWith("refs/heads/")) throw new Error("HEAD is not a local branch");
    await command(["check-ref-format", ref], signal);
    return ref.slice("refs/heads/".length);
  };

  const commit = async (ref = "HEAD", signal?: AbortSignal): Promise<string> => {
    const value = (
      await command(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal)
    ).stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Expected a commit");
    return value;
  };

  const branchExists = async (name: string, signal?: AbortSignal): Promise<boolean> => {
    assertBranchName(name);
    return (
      (await command(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], signal, [0, 1])).code === 0
    );
  };

  const ancestor = async (older: string, newer: string, signal?: AbortSignal): Promise<boolean> => {
    return (await command(["merge-base", "--is-ancestor", older, newer], signal, [0, 1])).code === 0;
  };

  const configValues = async (key: string, signal?: AbortSignal): Promise<string[]> => {
    const result = await command(["config", "--null", "--get-all", key], signal, [0, 1]);
    return result.code === 1 ? [] : result.stdout.split("\0").slice(0, -1);
  };

  const readUpstream = async (branch: string, signal?: AbortSignal): Promise<GitState["upstream"]> => {
    const remote = await configValues(`branch.${branch}.remote`, signal);
    const merge = await configValues(`branch.${branch}.merge`, signal);
    if (!remote.length && !merge.length) return null;
    const local = remote.length === 1 && remote[0] === ".";
    let ref = merge[0] || "(invalid upstream)";
    let exists = false;
    if (remote.length === 1 && merge.length === 1 && ref.startsWith("refs/heads/")) {
      try {
        await command(["check-ref-format", ref], signal);
        if (!local)
          ref =
            (
              await command(["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`], signal)
            ).stdout.trim() || `${remote[0]}:${ref}`;
        await command(["check-ref-format", ref], signal);
        await commit(ref, signal);
        exists = true;
      } catch {
        signal?.throwIfAborted();
      }
    }
    return { ref, kind: local ? "local" : "remote", exists };
  };

  const state = async (signal?: AbortSignal): Promise<GitState> => {
    const branch = await readBranch(signal);
    const head = await commit("HEAD", signal);
    const has = async (name: string): Promise<boolean> => {
      try {
        await access(join(location.gitDir, name));
        return true;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return false;
        throw error;
      }
    };
    const operation =
      (await has("rebase-merge")) || (await has("rebase-apply"))
        ? "rebase"
        : (await has("MERGE_HEAD"))
          ? "merge"
          : null;
    // Additional sequencers are unsafe to declare complete too, without inventing a merge state.
    if ((await has("CHERRY_PICK_HEAD")) || (await has("REVERT_HEAD")) || (await has("sequencer")))
      throw new Error("Finish the active cherry-pick/revert sequence first");
    if (
      (await command(["ls-files", "--stage", "-z"], signal)).stdout
        .split("\0")
        .some((entry) => entry.startsWith("160000 "))
    ) {
      throw new Error("Submodule worktrees require manual Git checks/integration in this version");
    }
    const conflicts = (await command(["ls-files", "--unmerged", "-z"], signal)).stdout.length > 0;
    const dirty =
      (
        await command(
          ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
          signal,
        )
      ).stdout.length > 0;
    const upstream = branch ? await readUpstream(branch, signal) : null;
    let containedByUpstream = false;
    let containsUpstream = false;
    if (upstream?.exists) {
      const target = await commit(upstream.ref, signal);
      containedByUpstream = await ancestor(head, target, signal);
      containsUpstream = await ancestor(target, head, signal);
    }
    return {
      branch,
      head,
      upstream,
      conflicts,
      dirty,
      operation,
      status: classifyState({ conflicts, dirty, operation, upstream, containedByUpstream, containsUpstream }),
    };
  };
  return { branch: readBranch, commit, branchExists, ancestor, upstream: readUpstream, state };
};
