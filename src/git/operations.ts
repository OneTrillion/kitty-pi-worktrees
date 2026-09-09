import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertBranchName } from "../shared/branch.ts";
import { classifyState, requireClean, type GitState } from "../shared/git-state.ts";
import { plainText } from "../shared/title.ts";

const exec = promisify(execFile);
export interface GitLocation { worktreePath: string; gitDir: string; commonGitDir: string }

/** Runs INSIDE a task/helper container (or temporary test repo), never against host projects. */
export class GitOperations {
  private overrides: string[] = [];
  readonly location: GitLocation;
  constructor(location: GitLocation) { this.location = location; }

  private async command(args: string[], signal?: AbortSignal, accepted = [0]): Promise<{ stdout: string; code: number }> {
    try {
      const result = await exec("git", [
        "--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
        "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "commit.gpgSign=false",
        "-c", "merge.verifySignatures=false", "-c", "submodule.recurse=false", ...this.overrides,
        "--git-dir", this.location.gitDir, "--work-tree", this.location.worktreePath, ...args,
      ], {
        cwd: this.location.worktreePath, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C", GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_COMMON_DIR: this.location.commonGitDir,
          GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "/bin/true" },
        ...(signal ? { signal } : {}),
      });
      return { stdout: result.stdout, code: 0 };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof failure.code === "number" && accepted.includes(failure.code)) return { code: failure.code, stdout: failure.stdout ?? "" };
      signal?.throwIfAborted();
      throw new Error(plainText(failure.stderr || (error instanceof Error ? error.message : "Git failed"), 2000), { cause: error });
    }
  }

  /** Disable configured executable filters/drivers, not just hooks. No project checks. */
  async prepare(signal?: AbortSignal): Promise<void> {
    this.overrides = [];
    const { stdout } = await this.command(["config", "--null", "--name-only", "--get-regexp", "^(filter|merge)\\."], signal, [0, 1]);
    const keys = stdout.split("\0").filter(Boolean);
    const filters = new Set<string>();
    const drivers = new Set<string>();
    for (const key of keys) {
      // -c uses '=' as its delimiter. Refuse ambiguous keys rather than allow a
      // configured program to escape the fixed overrides below.
      if (/[=\p{Cc}\p{Cf}]/u.test(key)) throw new Error("Unsupported executable Git config key; use manual Git operations");
      const filter = /^(filter\..+)\.(clean|smudge|process|required)$/.exec(key);
      if (filter) filters.add(filter[1]!);
      const driver = /^(merge\..+)\.driver$/.exec(key);
      if (driver) drivers.add(driver[1]!);
    }
    for (const filter of filters) this.overrides.push("-c", `${filter}.clean=/bin/cat`, "-c", `${filter}.smudge=/bin/cat`,
      "-c", `${filter}.process=`, "-c", `${filter}.required=false`);
    for (const driver of drivers) this.overrides.push("-c", `${driver}.driver=/bin/false`);
  }

  async branch(signal?: AbortSignal): Promise<string | null> {
    const result = await this.command(["symbolic-ref", "--quiet", "HEAD"], signal, [0, 1]);
    if (result.code === 1) return null;
    const ref = result.stdout.trimEnd();
    if (!ref.startsWith("refs/heads/")) throw new Error("HEAD is not a local branch");
    await this.command(["check-ref-format", ref], signal);
    return ref.slice("refs/heads/".length);
  }
  async commit(ref = "HEAD", signal?: AbortSignal): Promise<string> {
    const value = (await this.command(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal)).stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Expected a commit");
    return value;
  }
  async branchExists(name: string, signal?: AbortSignal): Promise<boolean> {
    assertBranchName(name);
    return (await this.command(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], signal, [0, 1])).code === 0;
  }
  async ancestor(older: string, newer: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.command(["merge-base", "--is-ancestor", older, newer], signal, [0, 1])).code === 0;
  }
  private async configValues(key: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.command(["config", "--null", "--get-all", key], signal, [0, 1]);
    return result.code === 1 ? [] : result.stdout.split("\0").slice(0, -1);
  }
  async upstream(branch: string, signal?: AbortSignal): Promise<GitState["upstream"]> {
    const remote = await this.configValues(`branch.${branch}.remote`, signal);
    const merge = await this.configValues(`branch.${branch}.merge`, signal);
    if (!remote.length && !merge.length) return null;
    const local = remote.length === 1 && remote[0] === ".";
    let ref = merge[0] || "(invalid upstream)";
    let exists = false;
    if (remote.length === 1 && merge.length === 1 && ref.startsWith("refs/heads/")) {
      try {
        await this.command(["check-ref-format", ref], signal);
        if (!local) ref = (await this.command(["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`], signal)).stdout.trim() || `${remote[0]}:${ref}`;
        await this.command(["check-ref-format", ref], signal);
        await this.commit(ref, signal);
        exists = true;
      } catch { signal?.throwIfAborted(); }
    }
    return { ref, kind: local ? "local" : "remote", exists };
  }
  async state(signal?: AbortSignal): Promise<GitState> {
    const branch = await this.branch(signal);
    const head = await this.commit("HEAD", signal);
    const has = async (name: string): Promise<boolean> => {
      try { await access(join(this.location.gitDir, name)); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    };
    const operation = await has("rebase-merge") || await has("rebase-apply") ? "rebase" : await has("MERGE_HEAD") ? "merge" : null;
    // Additional sequencers are unsafe to declare complete too, without inventing a merge state.
    if (await has("CHERRY_PICK_HEAD") || await has("REVERT_HEAD") || await has("sequencer")) throw new Error("Finish the active cherry-pick/revert sequence first");
    if ((await this.command(["ls-files", "--stage", "-z"], signal)).stdout.split("\0").some((entry) => entry.startsWith("160000 "))) {
      throw new Error("Submodule worktrees require manual Git checks/integration in this version");
    }
    const conflicts = (await this.command(["ls-files", "--unmerged", "-z"], signal)).stdout.length > 0;
    const dirty = (await this.command(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], signal)).stdout.length > 0;
    const upstream = branch ? await this.upstream(branch, signal) : null;
    let containedByUpstream = false;
    let containsUpstream = false;
    if (upstream?.exists) {
      const target = await this.commit(upstream.ref, signal);
      containedByUpstream = await this.ancestor(head, target, signal);
      containsUpstream = await this.ancestor(target, head, signal);
    }
    return { branch, head, upstream, conflicts, dirty, operation,
      status: classifyState({ conflicts, dirty, operation, upstream, containedByUpstream, containsUpstream }) };
  }

  async createWorktree(branch: string, destination: string, source: { branch: string | null; head: string }, signal?: AbortSignal): Promise<void> {
    assertBranchName(branch);
    const exists = await this.branchExists(branch, signal);
    if (!exists) {
      if (!source.branch) throw new Error("Cannot create a task from detached HEAD; check out a local source branch first");
      const sourceRef = `refs/heads/${source.branch}`;
      if (await this.commit(sourceRef, signal) !== source.head) throw new Error("Source branch changed; inspect it and retry");
      await this.command(["branch", "--no-track", "--", branch, source.head], signal);
      await this.command(["branch", `--set-upstream-to=${sourceRef}`, "--", branch], signal);
    }
    // No force and no reset/cleanup on failure. Existing upstream configuration is preserved.
    await this.command(["worktree", "add", "--", destination, branch], signal);
  }

  async done(signal?: AbortSignal): Promise<GitState> {
    await this.prepare(signal);
    const state = await this.state(signal);
    requireClean(state);
    return state;
  }
  async sync(signal?: AbortSignal): Promise<{ state: GitState; conflict: boolean }> {
    const before = await this.done(signal);
    if (!before.branch || before.upstream?.kind !== "local" || !before.upstream.exists) {
      throw new Error("Sync needs a resolving LOCAL upstream. Set the parent with git branch --set-upstream-to=<parent>; do not replace it with git push -u");
    }
    const target = await this.commit(before.upstream.ref, signal);
    const result = await this.command(["merge", "--no-edit", "--no-verify", "--no-gpg-sign", "--", target], signal, [0, 1]);
    const state = await this.state(signal);
    if (result.code && !state.conflicts && !state.operation) throw new Error("Git merge failed; inspect the task worktree");
    return { state, conflict: state.conflicts || state.operation !== null };
  }

  /** inspectTask must read the other worktree through the narrow supervisor protocol. */
  async integrate(branch: string, inspectTask: () => Promise<GitState>, signal?: AbortSignal): Promise<GitState> {
    assertBranchName(branch);
    const target = await this.done(signal);
    if (!target.branch || target.branch === branch) throw new Error("Run integration from a different local target branch's tab");
    const taskRef = `refs/heads/${branch}`;
    const parent = await this.upstream(branch, signal);
    if (parent?.kind !== "local" || parent.ref !== `refs/heads/${target.branch}` || !parent.exists) {
      throw new Error("The task's local upstream must be this target branch");
    }
    const task = await inspectTask();
    requireClean(task);
    if (task.branch !== branch || task.upstream?.kind !== "local" || task.upstream.ref !== parent.ref || !task.upstream.exists ||
        task.head !== await this.commit(taskRef, signal)) throw new Error("Task changed during inspection; retry after it settles");
    if (!await this.ancestor(target.head, task.head, signal)) throw new Error("Target cannot fast-forward. Run /worktree-sync in the task tab, resolve conflicts, then retry");
    const current = await this.done(signal);
    const currentParent = await this.upstream(branch, signal);
    if (current.branch !== target.branch || current.head !== target.head || await this.commit(taskRef, signal) !== task.head ||
        currentParent?.ref !== parent.ref || currentParent.kind !== "local" || !currentParent.exists) throw new Error("Branches changed during integration checks; retry");
    await this.command(["merge", "--ff-only", "--no-edit", "--no-verify", "--no-gpg-sign", "--", task.head], signal);
    return this.state(signal);
  }
}
