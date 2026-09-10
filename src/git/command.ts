import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitLocation } from "../shared/helper.ts";
import { plainText } from "../shared/title.ts";
import { isRecord } from "../shared/validation.ts";

const exec = promisify(execFile);

/** Container-only Git execution. Suppresses callbacks, credentials and network access. */
export const createGitCommand = (location: GitLocation) => {
  let overrides: string[] = [];

  const command = async (
    args: string[],
    signal?: AbortSignal,
    accepted = [0],
  ): Promise<{ stdout: string; code: number }> => {
    try {
      const result = await exec(
        "git",
        [
          "--no-pager",
          "--no-optional-locks",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "merge.verifySignatures=false",
          "-c",
          "submodule.recurse=false",
          ...overrides,
          "--git-dir",
          location.gitDir,
          "--work-tree",
          location.worktreePath,
          ...args,
        ],
        {
          cwd: location.worktreePath,
          encoding: "utf8",
          timeout: 120000,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: "/tmp",
            LANG: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_COMMON_DIR: location.commonGitDir,
            GIT_NO_LAZY_FETCH: "1",
            GIT_ALLOW_PROTOCOL: "",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_TERMINAL_PROMPT: "0",
            GIT_EDITOR: "/bin/true",
          },
          ...(signal ? { signal } : {}),
        },
      );
      return { stdout: result.stdout, code: 0 };
    } catch (error) {
      signal?.throwIfAborted();
      const failure = isRecord(error) ? error : {};
      const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
      const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
      if (typeof failure.code === "number" && accepted.includes(failure.code)) {
        return { code: failure.code, stdout };
      }
      throw new Error(plainText(stderr || (error instanceof Error ? error.message : "Git failed"), 2000), {
        cause: error,
      });
    }
  };

  /** Disable configured executable filters/drivers, not just hooks. No project checks. */
  const prepare = async (signal?: AbortSignal): Promise<void> => {
    overrides = [];
    const { stdout } = await command(
      ["config", "--null", "--name-only", "--get-regexp", "^(filter|merge)\\."],
      signal,
      [0, 1],
    );
    const keys = stdout.split("\0").filter(Boolean);
    const filters = new Set<string>();
    const drivers = new Set<string>();
    for (const key of keys) {
      // -c uses '=' as its delimiter. Refuse ambiguous keys rather than allow a
      // configured program to escape the fixed overrides below.
      if (/[=\p{Cc}\p{Cf}]/u.test(key))
        throw new Error("Unsupported executable Git config key; use manual Git operations");
      const filter = /^(filter\..+)\.(clean|smudge|process|required)$/.exec(key);
      if (filter?.[1]) filters.add(filter[1]);
      const driver = /^(merge\..+)\.driver$/.exec(key);
      if (driver?.[1]) drivers.add(driver[1]);
    }
    for (const filter of filters)
      overrides.push(
        "-c",
        `${filter}.clean=/bin/cat`,
        "-c",
        `${filter}.smudge=/bin/cat`,
        "-c",
        `${filter}.process=`,
        "-c",
        `${filter}.required=false`,
      );
    for (const driver of drivers) overrides.push("-c", `${driver}.driver=/bin/false`);
  };
  return { command, prepare };
};
export type GitCommand = ReturnType<typeof createGitCommand>["command"];
