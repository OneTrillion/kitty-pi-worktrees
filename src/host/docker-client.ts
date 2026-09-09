import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { HostConfig } from "./config.ts";
import { pathsOverlap } from "./files.ts";
import { assertPrivateRuntimeRoot } from "./runtime.ts";

const exec = promisify(execFile);
const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
// Docker's inspect response has other fields. Read only the subset we need.
const containerSchema = z.object({
  Id: idSchema,
  Name: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Running: z.boolean(), Restarting: z.boolean(), Paused: z.boolean() }),
});
export type ContainerInfo = z.infer<typeof containerSchema>;
export interface AttachedContainer {
  completion: Promise<number>;
  disconnect(): Promise<void>;
}
export interface DockerClient {
  lookup(nameOrId: string): Promise<ContainerInfo | null>;
  create(args: string[]): Promise<string>;
  attach(id: string): AttachedContainer;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** executable is a trusted test seam, never a config/CLI/protocol field. */
export async function createDockerClient(config: HostConfig, privateConfigDir: string, executable = "/usr/bin/docker"): Promise<DockerClient> {
  await assertPrivateRuntimeRoot(privateConfigDir);
  const socketPath = await realpath(config.dockerSocket);
  const socket = await lstat(socketPath);
  if (!socket.isSocket() || (socket.uid !== 0 && socket.uid !== process.getuid!()) ||
      [config.repositoryPath, config.worktreeRoot].some((root) => pathsOverlap(root, socketPath))) {
    throw new Error("Docker endpoint must be a trusted local Unix socket outside task mounts");
  }
  const binary = await realpath(executable);
  if ([config.repositoryPath, config.worktreeRoot].some((root) => pathsOverlap(root, binary))) {
    throw new Error("Docker executable must be outside task mounts");
  }
  const prefix = ["--host", `unix://${socketPath}`, "--config", privateConfigDir];
  const env = { PATH: "/usr/bin:/bin", HOME: privateConfigDir, LANG: "C", TERM: "xterm-256color" };
  async function command(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(binary, [...prefix, ...args], {
        cwd: privateConfigDir, env, encoding: "utf8", timeout: 20000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch (cause) {
      throw new Error(`Docker ${args[0]} failed; verify the local daemon, image and permissions`, { cause });
    }
  }
  async function matchingIds(target: string): Promise<string[]> {
    const filter = /^[a-f0-9]{64}$/.test(target) ? `id=${target}` : `name=^/${target}$`;
    const output = await command(["container", "ls", "--all", "--no-trunc", "--quiet", "--filter", filter]);
    const ids = output ? output.split("\n").map((id) => idSchema.parse(id)) : [];
    if (ids.length > 1) throw new Error("Docker returned an ambiguous container identity");
    return ids;
  }
  return {
    async lookup(target) {
      if (!/^(?:[a-f0-9]{64}|pi-worktree-[a-f0-9]{64})$/.test(target)) throw new Error("Invalid container identity");
      const [id] = await matchingIds(target);
      if (!id) return null; // Successful list, not an error interpreted as absence.
      try {
        const info = containerSchema.parse(JSON.parse(await command(["container", "inspect", "--format", "{{json .}}", id])));
        if (info.Id !== id || (!/^[a-f0-9]{64}$/.test(target) && info.Name !== `/${target}`)) {
          throw new Error("Docker container identity mismatch");
        }
        return info;
      } catch (error) {
        // Another trusted host process may have removed it between list and inspect.
        if ((await matchingIds(id)).length === 0) return null;
        throw error;
      }
    },
    async create(args) {
      if (args[0] !== "create") throw new Error("Expected fixed Docker create arguments");
      return idSchema.parse(await command(args));
    },
    attach(id) {
      idSchema.parse(id);
      const child = spawn(binary, [...prefix, "container", "start", "--attach", "--interactive", id], {
        cwd: privateConfigDir, env, stdio: "inherit",
      });
      const completion = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      return {
        completion,
        async disconnect() {
          // Only called AFTER the container has been removed; this cannot leave an editor running.
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await completion.catch(() => {});
        },
      };
    },
    async stop(id) { await command(["container", "stop", "--time", "10", idSchema.parse(id)]); },
    async remove(id) { await command(["container", "rm", idSchema.parse(id)]); },
  };
}
