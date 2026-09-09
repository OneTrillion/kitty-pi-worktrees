import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

/** Host-selected location, outside all task mounts; shared by this user's supervisors. */
export async function prepareRuntimeRoot(path: string): Promise<string> {
  if (!process.getuid || !isAbsolute(path) || normalize(path) !== path || path.endsWith("/") || /[\p{Cc}\p{Cf}]/u.test(path)) {
    throw new Error("Runtime root must be a normalized absolute POSIX path");
  }
  // Do not create through a parent symlink. Parent selection remains a host responsibility.
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error("Runtime parent must be canonical");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertPrivateRuntimeRoot(path);
  return path;
}

export async function assertPrivateRuntimeRoot(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 || await realpath(path) !== path) {
    throw new Error("Runtime root must be a canonical, user-owned directory with mode 0700");
  }
}

export async function createRuntimeDirectory(root: string): Promise<{
  directory: string;
  socketPath: string;
  remove: () => Promise<void>;
}> {
  await assertPrivateRuntimeRoot(root);
  // Keep below Unix sockaddr_un limits. Check before allocating a directory.
  if (Buffer.byteLength(join(root, "tab-XXXXXX", "socket")) > 100) {
    throw new Error("Runtime root is too long for a Unix socket; choose a shorter host path");
  }
  const directory = await mkdtemp(join(root, "tab-"));
  let removal: Promise<void> | undefined;
  return {
    directory,
    socketPath: join(directory, "socket"),
    // Only the host-created per-tab directory is removed, never the shared lock files.
    remove: () => removal ??= rm(directory, { recursive: true, force: true }),
  };
}
