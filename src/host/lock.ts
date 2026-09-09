import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { worktreeId } from "./paths.ts";
import { assertPrivateRuntimeRoot } from "./runtime.ts";

export class WorktreeBusyError extends Error {
  constructor() {
    super("This worktree is already open in another managed session");
    this.name = "WorktreeBusyError";
  }
}

/**
 * Linux flock locks belong to an open file description. The utility locks our
 * inherited fd, then exits; the parent retains the lock until its fd is closed.
 * No helper daemon, PID file, native npm addon, or stale-lock recovery is needed.
 */
export async function acquireWorktreeLock(runtimeRoot: string, worktreePath: string): Promise<{
  canonicalPath: string;
  release: () => Promise<void>;
}> {
  if (process.platform !== "linux") throw new Error("Worktree locking currently requires Linux and util-linux /usr/bin/flock");
  await assertPrivateRuntimeRoot(runtimeRoot);
  const canonicalPath = await realpath(worktreePath);
  if (!(await stat(canonicalPath)).isDirectory()) throw new Error("Worktree must be a directory");
  const lockPath = join(runtimeRoot, `${worktreeId(canonicalPath)}.lock`);
  const file = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600) {
      throw new Error("Lock must be a user-owned regular file with mode 0600 and no hard links");
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"], {
        cwd: runtimeRoot,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        stdio: ["ignore", "ignore", "ignore", file.fd],
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else if (code === 73) reject(new WorktreeBusyError());
        else reject(new Error("Unable to acquire host advisory lock; check /usr/bin/flock"));
      });
    });
  } catch (error) {
    await file.close();
    throw error;
  }
  let released: Promise<void> | undefined;
  return {
    canonicalPath,
    release: () => released ??= file.close(),
  };
}

/** A live snapshot for future listing; it does not reserve an open/closed state. */
export async function isWorktreeOpen(runtimeRoot: string, worktreePath: string): Promise<boolean> {
  try {
    const lock = await acquireWorktreeLock(runtimeRoot, worktreePath);
    await lock.release();
    return false;
  } catch (error) {
    if (error instanceof WorktreeBusyError) return true;
    throw error;
  }
}
