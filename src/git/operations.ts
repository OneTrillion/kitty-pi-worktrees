import { assertBranchName } from "../shared/branch.ts";
import { requireClean, type GitState } from "../shared/git-state.ts";
import type { GitLocation } from "../shared/helper.ts";
import { createGitCommand } from "./command.ts";
import { createGitReader } from "./state.ts";

/** Runs inside a task/helper container or temporary test repo, never against host projects. */
export const createGitOperations = (location: GitLocation) => {
  const { command, prepare } = createGitCommand(location);
  const reader = createGitReader(location, command);
  const { branchExists, commit, ancestor, upstream, state: readState } = reader;

  const createWorktree = async (
    branch: string,
    destination: string,
    source: { branch: string | null; head: string },
    signal?: AbortSignal,
  ): Promise<void> => {
    assertBranchName(branch);
    const exists = await branchExists(branch, signal);
    if (!exists) {
      if (!source.branch)
        throw new Error("Cannot create a task from detached HEAD; check out a local source branch first");
      const sourceRef = `refs/heads/${source.branch}`;
      if ((await commit(sourceRef, signal)) !== source.head)
        throw new Error("Source branch changed; inspect it and retry");
      await command(["branch", "--no-track", "--", branch, source.head], signal);
      await command(["branch", `--set-upstream-to=${sourceRef}`, "--", branch], signal);
    }
    // No force and no reset/cleanup on failure. Existing upstream configuration is preserved.
    await command(["worktree", "add", "--", destination, branch], signal);
  };

  const done = async (signal?: AbortSignal): Promise<GitState> => {
    await prepare(signal);
    const state = await readState(signal);
    requireClean(state);
    return state;
  };

  const sync = async (signal?: AbortSignal): Promise<{ state: GitState; conflict: boolean }> => {
    const before = await done(signal);
    if (!before.branch || before.upstream?.kind !== "local" || !before.upstream.exists) {
      throw new Error(
        "Sync needs a resolving LOCAL upstream. Set the parent with git branch --set-upstream-to=<parent>; do not replace it with git push -u",
      );
    }
    const target = await commit(before.upstream.ref, signal);
    const result = await command(
      ["merge", "--no-edit", "--no-verify", "--no-gpg-sign", "--", target],
      signal,
      [0, 1],
    );
    const state = await readState(signal);
    if (result.code && !state.conflicts && !state.operation)
      throw new Error("Git merge failed; inspect the task worktree");
    return { state, conflict: state.conflicts || state.operation !== null };
  };

  /** inspectTask must read the other worktree through the narrow supervisor protocol. */
  const integrate = async (
    branch: string,
    inspectTask: () => Promise<GitState>,
    signal?: AbortSignal,
  ): Promise<GitState> => {
    assertBranchName(branch);
    const target = await done(signal);
    if (!target.branch || target.branch === branch)
      throw new Error("Run integration from a different local target branch's tab");
    const taskRef = `refs/heads/${branch}`;
    const parent = await upstream(branch, signal);
    if (parent?.kind !== "local" || parent.ref !== `refs/heads/${target.branch}` || !parent.exists) {
      throw new Error("The task's local upstream must be this target branch");
    }
    const task = await inspectTask();
    requireClean(task);
    if (
      task.branch !== branch ||
      task.upstream?.kind !== "local" ||
      task.upstream.ref !== parent.ref ||
      !task.upstream.exists ||
      task.head !== (await commit(taskRef, signal))
    )
      throw new Error("Task changed during inspection; retry after it settles");
    if (!(await ancestor(target.head, task.head, signal)))
      throw new Error(
        "Target cannot fast-forward. Run /worktree-sync in the task tab, resolve conflicts, then retry",
      );
    const current = await done(signal);
    const currentParent = await upstream(branch, signal);
    if (
      current.branch !== target.branch ||
      current.head !== target.head ||
      (await commit(taskRef, signal)) !== task.head ||
      currentParent?.ref !== parent.ref ||
      currentParent.kind !== "local" ||
      !currentParent.exists
    )
      throw new Error("Branches changed during integration checks; retry");
    await command(
      ["merge", "--ff-only", "--no-edit", "--no-verify", "--no-gpg-sign", "--", task.head],
      signal,
    );
    return readState(signal);
  };
  return { ...reader, prepare, createWorktree, done, sync, integrate };
};
export type GitOperations = ReturnType<typeof createGitOperations>;
