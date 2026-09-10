import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertBranchName } from "../shared/branch.ts";

const execFileAsync = promisify(execFile);

/** Validate before filesystem operations; --branch shorthand is intentionally avoided. */
export const validateBranchName = async (name: string): Promise<void> => {
  assertBranchName(name);
  // check-ref-format needs no repository and runs no project hooks or filters.
  // The fully qualified ref prevents expansion of @{-1} or revision expressions.
  await execFileAsync("/usr/bin/git", ["check-ref-format", `refs/heads/${name}`], {
    cwd: "/",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    timeout: 5000,
    killSignal: "SIGKILL",
    maxBuffer: 8192,
  });
};
