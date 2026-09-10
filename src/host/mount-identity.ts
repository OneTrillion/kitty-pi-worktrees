import { lstat } from "node:fs/promises";
import { assertCanonicalDirectory } from "./files.ts";

/** Detect observed host directory replacement across stopped Docker creation. */
export const pinMountDirectories = async (paths: string[]): Promise<() => Promise<void>> => {
  const pins = await Promise.all(
    [...new Set(paths)].map(async (path) => {
      await assertCanonicalDirectory(path);
      const info = await lstat(path, { bigint: true });
      return { path, dev: info.dev, ino: info.ino };
    }),
  );
  return async () => {
    for (const pin of pins) {
      await assertCanonicalDirectory(pin.path);
      const info = await lstat(pin.path, { bigint: true });
      if (info.dev !== pin.dev || info.ino !== pin.ino)
        throw new Error("A mount directory changed during startup");
    }
  };
};
