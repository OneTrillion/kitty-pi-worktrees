import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HostConfig } from "./config.ts";
import { pathsOverlap } from "./files.ts";
import { formatTitle } from "../shared/title.ts";

const exec = promisify(execFile);

export function kittyLaunchArgs(socket: string, configPath: string, worktreePath: string, branch: string | null): string[] {
  if (![socket, configPath, worktreePath].every((path) => isAbsolute(path) && !/[\p{Cc}\p{Cf}]/u.test(path))) {
    throw new Error("Kitty launch requires host-selected absolute paths");
  }
  // No match/focus/set-colors/remote-control privileges, no shell, no tab-title
  // override (Pi must be able to change its window's title after startup).
  return ["@", "--to", `unix:${socket}`, "launch", "--type=tab", "--keep-focus", "--hold",
    "--cwd", worktreePath, "--title", formatTitle("starting", branch),
    process.execPath, fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url)), "start", "--config", configPath];
}

/** Only creates a NEW tab. No container field selects a command, socket or Kitty target. */
export async function launchInKitty(config: HostConfig, configPath: string, path: string, branch: string | null,
  signal?: AbortSignal, executable = "/usr/bin/kitty"): Promise<void> {
  const inherited = process.env.KITTY_LISTEN_ON;
  const selected = config.kittySocket ?? (inherited?.startsWith("unix:") ? inherited.slice(5) : undefined);
  if (!selected) throw new Error("Configure kittySocket or launch from Kitty with socket-only remote control enabled");
  const socket = await realpath(selected);
  const info = await lstat(socket);
  const binary = await realpath(executable);
  if (!info.isSocket() || (info.uid !== process.getuid!() && info.uid !== 0) ||
      [config.repositoryPath, config.worktreeRoot].some((root) => pathsOverlap(root, socket) || pathsOverlap(root, binary))) {
    throw new Error("Kitty socket/executable must be trusted host resources outside task mounts");
  }
  try {
    await exec(binary, kittyLaunchArgs(socket, configPath, path, branch), {
      cwd: config.runtimeRoot, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", TERM: "xterm-256color" },
      timeout: 10000, killSignal: "SIGKILL", maxBuffer: 8192, ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    throw new Error("Kitty launch failed; the worktree is preserved. Open it with the host start command", { cause });
  }
}
