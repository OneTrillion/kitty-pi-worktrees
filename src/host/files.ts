import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";

/** Bounded reads of metadata; never follow a final symlink or block on a FIFO. */
export const readRegularFile = async (path: string, maxBytes: number) => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error("Expected a regular file without hard links");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("Host metadata file exceeds its size limit");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)), info };
  } finally {
    await file.close();
  }
};

export const containsPath = (parent: string, child: string): boolean => {
  return parent === child || child.startsWith(parent + "/");
};

export const pathsOverlap = (a: string, b: string): boolean => {
  return containsPath(a, b) || containsPath(b, a);
};

export const assertCanonicalDirectory = async (path: string): Promise<void> => {
  if ((await realpath(path)) !== path || !(await stat(path)).isDirectory()) {
    throw new Error("Expected a canonical directory without symlink aliases");
  }
};
