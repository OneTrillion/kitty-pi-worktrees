import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateDirectoryMount } from "./docker.ts";
import { assertCanonicalDirectory, pathsOverlap, readRegularFile } from "./files.ts";

const absolutePath = z.string().refine((value) =>
  isAbsolute(value) && normalize(value) === value && !value.endsWith("/") && !/[\p{Cc}\p{Cf}]/u.test(value),
"Expected a normalized absolute path without controls");
const HostConfigSchema = z.strictObject({
  image: z.string().min(1).refine((value) => !value.startsWith("-") && !/[\s\p{Cc}\p{Cf}]/u.test(value)),
  agentVolume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/),
  repositoryPath: absolutePath,
  worktreeRoot: absolutePath,
  runtimeRoot: absolutePath,
  dockerSocket: absolutePath.default("/var/run/docker.sock"),
  kittySocket: absolutePath.optional(),
});
export type HostConfig = Readonly<z.infer<typeof HostConfigSchema>>;

/**
 * Explicit host-side configuration, never project auto-discovery or socket data.
 * Repository and worktree-root directories must already exist. Runtime root may
 * be created later by prepareRuntimeRoot; loading config creates nothing.
 */
export async function loadHostConfig(configPath: string): Promise<HostConfig> {
  if (process.platform !== "linux") throw new Error("The current host implementation supports Linux only");
  absolutePath.parse(configPath);
  await assertCanonicalDirectory(dirname(configPath));
  const { text, info } = await readRegularFile(configPath, 64 * 1024);
  if ((info.uid !== process.getuid!() && info.uid !== 0) || (info.mode & 0o022) !== 0) {
    throw new Error("Host config must be owned by this user or root, and not group/world writable");
  }
  const config = HostConfigSchema.parse(JSON.parse(text));
  for (const path of [config.repositoryPath, config.worktreeRoot]) {
    validateDirectoryMount(path);
    await assertCanonicalDirectory(path);
  }
  await assertCanonicalDirectory(dirname(config.runtimeRoot));
  if (pathsOverlap(config.repositoryPath, config.worktreeRoot)) {
    throw new Error("Repository and task worktree root must be separate, non-nested directories");
  }
  // Both src/host and dist/host resolve here to the installation/package root.
  // Includes runtime dependencies, not just the launcher entry point.
  const installationRoot = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  for (const protectedPath of [configPath, installationRoot, await realpath(process.execPath), config.runtimeRoot, config.dockerSocket,
    ...(config.kittySocket ? [config.kittySocket] : [])]) {
    for (const mountedRoot of [config.repositoryPath, config.worktreeRoot]) {
      if (pathsOverlap(mountedRoot, protectedPath)) {
        throw new Error("Host config, installed code, and runtime must stay outside task mounts");
      }
    }
  }
  // Initial layout: a normal main checkout with an actual .git directory.
  // A .git file/separate Git directory or bare repository needs an explicit future policy.
  await assertCanonicalDirectory(join(config.repositoryPath, ".git"));
  return Object.freeze(config);
}
