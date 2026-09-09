import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { HostConfig } from "./config.ts";
import { validateDirectoryMount } from "./docker.ts";
import { assertCanonicalDirectory, containsPath, readRegularFile } from "./files.ts";
import { parseWorktreeRecords } from "../shared/worktree-records.ts";
import { assertBranchName } from "../shared/branch.ts";

const exec = promisify(execFile);
interface GitLocation {
  worktreePath: string;
  gitDir: string;
  commonGitDir: string;
}
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
async function readGit(location: GitLocation, args: string[], signal?: AbortSignal, detachedAllowed = false): Promise<string | null> {
  try {
    const { stdout } = await exec("/usr/bin/git", [
      "--no-pager", "--no-optional-locks",
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.bare=false",
      "--git-dir", location.gitDir, "--work-tree", location.worktreePath,
      ...args,
    ], {
      cwd: "/",
      env: {
        PATH: "/usr/bin:/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_COMMON_DIR: location.commonGitDir, GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "",
      },
      encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    return stdout;
  } catch (cause) {
    if (detachedAllowed && (cause as { code?: unknown }).code === 1) return null;
    throw new Error("Read-only Git discovery failed; inspect the repository's metadata/configuration on the host", { cause });
  }
}

/** NUL porcelain avoids Git's quoting of paths containing spaces/newlines. No status cache. */
export function parseWorktreePaths(output: string): string[] {
  if (!output.endsWith("\0\0")) throw new Error("Invalid Git worktree porcelain output");
  const paths = output.slice(0, -2).split("\0\0").map((record) => {
    const first = record.split("\0", 1)[0]!;
    if (!first.startsWith("worktree /")) throw new Error("Invalid Git worktree path record");
    return first.slice("worktree ".length);
  });
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate Git worktree paths");
  return paths;
}

export function isAuthorizedWorktree(config: HostConfig, path: string): boolean {
  // Tasks are immediate children of the dedicated root, not arbitrary descendants.
  return path === config.repositoryPath || (dirname(path) === config.worktreeRoot && !/[\p{Cc}\p{Cf}]/u.test(path));
}

async function pointer(path: string, prefix = ""): Promise<string> {
  const { text } = await readRegularFile(path, 8192);
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!line.startsWith(prefix) || line.length === prefix.length || /[\p{Cc}\p{Cf}]/u.test(line)) {
    throw new Error("Invalid Git worktree pointer file");
  }
  return line.slice(prefix.length);
}

/** Paths are authorized against HOST config before following any .git pointer. */
export async function locateGit(config: HostConfig, worktreePath: string): Promise<GitLocation> {
  if (!isAuthorizedWorktree(config, worktreePath)) throw new Error("Worktree is outside the host-authorized paths");
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
  if (resolve(gitDir, await pointer(join(gitDir, "commondir"))) !== commonGitDir ||
      resolve(gitDir, await pointer(join(gitDir, "gitdir"))) !== gitFile) {
    throw new Error("Git worktree pointers disagree; inspect/repair them explicitly on the host");
  }
  return { worktreePath, commonGitDir, gitDir };
}

export async function listGitWorktrees(config: HostConfig, signal?: AbortSignal) {
  const main = await locateGit(config, config.repositoryPath);
  return parseWorktreeRecords((await readGit(main, ["worktree", "list", "--porcelain", "-z"], signal))!);
}

export async function localBranchExists(config: HostConfig, branch: string, signal?: AbortSignal): Promise<boolean> {
  assertBranchName(branch);
  const main = await locateGit(config, config.repositoryPath);
  // Fixed read-only ref lookup; no revision expansion, lazy fetching or user commands.
  return await readGit(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal, true) !== null;
}

/** Discover the current host cwd and authorize it against the configured repository. */
export async function discoverCurrentWorktree(config: HostConfig, cwd: string, signal?: AbortSignal): Promise<DiscoveredWorktree> {
  signal?.throwIfAborted();
  const canonicalCwd = await realpath(cwd);
  await assertCanonicalDirectory(canonicalCwd);
  if (!(containsPath(config.repositoryPath, canonicalCwd) || containsPath(config.worktreeRoot, canonicalCwd)) ||
      containsPath(join(config.repositoryPath, ".git"), canonicalCwd)) {
    throw new Error("Start the launcher inside a worktree authorized by the host config");
  }
  const main = await locateGit(config, config.repositoryPath);
  const paths = parseWorktreePaths((await readGit(main, ["worktree", "list", "--porcelain", "-z"], signal))!);
  const worktreePath = paths.filter((path) => isAuthorizedWorktree(config, path) && containsPath(path, canonicalCwd))
    .sort((a, b) => b.length - a.length)[0];
  if (!worktreePath) throw new Error("Current directory is not a linked worktree in the authorized repository");
  // Do not silently select the outer project when cwd is in a nested repository/submodule.
  for (let dir = canonicalCwd; dir !== worktreePath; dir = dirname(dir)) {
    try {
      await lstat(join(dir, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Current directory is inside a different nested Git repository");
  }
  const location = await locateGit(config, worktreePath);
  const ref = await readGit(location, ["symbolic-ref", "--quiet", "HEAD"], signal, true);
  let branch: string | null = null;
  if (ref !== null) {
    const fullRef = ref.replace(/\n$/, "");
    if (!fullRef.startsWith("refs/heads/")) throw new Error("HEAD must name a local branch or be detached");
    await readGit(location, ["check-ref-format", fullRef], signal);
    branch = fullRef.slice("refs/heads/".length);
  }
  const head = (await readGit(location, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], signal))!.replace(/\n$/, "");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Worktree must have a readable commit before it can be launched");
  signal?.throwIfAborted();
  return { ...location, branch, head };
}
