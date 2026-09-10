import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertBranchName } from "../shared/branch.ts";
import type { GitLocation } from "../shared/helper.ts";
import { hasErrorCode } from "../shared/validation.ts";
import { parseWorktreeRecords } from "../shared/worktree-records.ts";
import type { HostConfig } from "./config.ts";
import { validateDirectoryMount } from "./docker.ts";
import { assertCanonicalDirectory, containsPath, readRegularFile } from "./files.ts";

const exec = promisify(execFile);

export interface DiscoveredWorktree extends GitLocation {
  branch: string | null;
  head: string;
}

/**
 * PRIVATE, discovery-only plumbing. These builtins do not run checkout filters,
 * project hooks or status/fsmonitor helpers. Lazy fetch and all network/helper
 * protocols are disabled too: even rev-parse can otherwise spawn a remote helper
 * for a missing promisor object. This is NOT a general safe Git runner:
 * do not add status, checkout, worktree add, merge, fetch, etc. here without a
 * separate execution-isolation design. Repository config is still read by Git.
 */
const readGit = async (
  location: GitLocation,
  args: string[],
  signal?: AbortSignal,
  allowMissingRef = false,
): Promise<{ stdout: string; code: number }> => {
  try {
    const { stdout } = await exec(
      "/usr/bin/git",
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.bare=false",
        "--git-dir",
        location.gitDir,
        "--work-tree",
        location.worktreePath,
        ...args,
      ],
      {
        cwd: "/",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          XDG_CONFIG_HOME: "/nonexistent",
          LANG: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_COMMON_DIR: location.commonGitDir,
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
        },
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
    );
    return { stdout, code: 0 };
  } catch (cause) {
    signal?.throwIfAborted();
    if (allowMissingRef && hasErrorCode(cause, 1)) return { stdout: "", code: 1 };
    throw new Error(
      "Read-only Git discovery failed; inspect the repository's metadata/configuration on the host",
      { cause },
    );
  }
};

export const isAuthorizedWorktree = (config: HostConfig, path: string): boolean => {
  // Tasks are immediate children of the dedicated root, not arbitrary descendants.
  return (
    path === config.repositoryPath || (dirname(path) === config.worktreeRoot && !/[\p{Cc}\p{Cf}]/u.test(path))
  );
};

const pointer = async (path: string, prefix = ""): Promise<string> => {
  const { text } = await readRegularFile(path, 8192);
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!line.startsWith(prefix) || line.length === prefix.length || /[\p{Cc}\p{Cf}]/u.test(line)) {
    throw new Error("Invalid Git worktree pointer file");
  }
  return line.slice(prefix.length);
};

/** Paths are authorized against HOST config before following any .git pointer. */
export const locateGit = async (config: HostConfig, worktreePath: string): Promise<GitLocation> => {
  if (!isAuthorizedWorktree(config, worktreePath))
    throw new Error("Worktree is outside the host-authorized paths");
  validateDirectoryMount(worktreePath);
  await assertCanonicalDirectory(worktreePath);
  const commonGitDir = join(config.repositoryPath, ".git");
  await assertCanonicalDirectory(commonGitDir);
  if (worktreePath === config.repositoryPath) return { worktreePath, commonGitDir, gitDir: commonGitDir };

  const gitFile = join(worktreePath, ".git");
  const gitDir = resolve(worktreePath, await pointer(gitFile, "gitdir: "));
  if (dirname(gitDir) !== join(commonGitDir, "worktrees")) {
    throw new Error("Linked .git pointer must refer to this repository's worktrees metadata");
  }
  await assertCanonicalDirectory(gitDir);
  if (
    resolve(gitDir, await pointer(join(gitDir, "commondir"))) !== commonGitDir ||
    resolve(gitDir, await pointer(join(gitDir, "gitdir"))) !== gitFile
  ) {
    throw new Error("Git worktree pointers disagree; inspect/repair them explicitly on the host");
  }
  return { worktreePath, commonGitDir, gitDir };
};

export const listGitWorktrees = async (config: HostConfig, signal?: AbortSignal) => {
  const main = await locateGit(config, config.repositoryPath);
  return parseWorktreeRecords(
    (await readGit(main, ["worktree", "list", "--porcelain", "-z"], signal)).stdout,
  );
};

export const localBranchExists = async (
  config: HostConfig,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  assertBranchName(branch);
  const main = await locateGit(config, config.repositoryPath);
  // Fixed read-only ref lookup; no revision expansion, lazy fetching or user commands.
  return (
    (await readGit(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal, true)).code ===
    0
  );
};

/** Discover the current host cwd and authorize it against the configured repository. */
export const discoverCurrentWorktree = async (
  config: HostConfig,
  cwd: string,
  signal?: AbortSignal,
): Promise<DiscoveredWorktree> => {
  signal?.throwIfAborted();
  const canonicalCwd = await realpath(cwd);
  await assertCanonicalDirectory(canonicalCwd);
  if (
    !(containsPath(config.repositoryPath, canonicalCwd) || containsPath(config.worktreeRoot, canonicalCwd)) ||
    containsPath(join(config.repositoryPath, ".git"), canonicalCwd)
  ) {
    throw new Error("Start the launcher inside a worktree authorized by the host config");
  }
  const records = await listGitWorktrees(config, signal);
  const worktreePath = records.find(
    ({ path }) => isAuthorizedWorktree(config, path) && containsPath(path, canonicalCwd),
  )?.path;
  if (!worktreePath)
    throw new Error("Current directory is not a linked worktree in the authorized repository");
  // Do not silently select the outer project when cwd is in a nested repository/submodule.
  for (let dir = canonicalCwd; dir !== worktreePath; dir = dirname(dir)) {
    try {
      await lstat(join(dir, ".git"));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    throw new Error("Current directory is inside a different nested Git repository");
  }
  const location = await locateGit(config, worktreePath);
  const ref = await readGit(location, ["symbolic-ref", "--quiet", "HEAD"], signal, true);
  let branch: string | null = null;
  if (ref.code === 0) {
    const fullRef = ref.stdout.replace(/\n$/, "");
    if (!fullRef.startsWith("refs/heads/")) throw new Error("HEAD must name a local branch or be detached");
    await readGit(location, ["check-ref-format", fullRef], signal);
    branch = fullRef.slice("refs/heads/".length);
  }
  const head = (
    await readGit(location, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], signal)
  ).stdout.replace(/\n$/, "");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
    throw new Error("Worktree must have a readable commit before it can be launched");
  signal?.throwIfAborted();
  return { ...location, branch, head };
};
