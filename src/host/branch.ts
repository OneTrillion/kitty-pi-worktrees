import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertBranchName } from "../shared/branch.ts";

const execFileAsync = promisify(execFile);

/** Validate before filesystem operations; --branch shorthand is intentionally avoided. */
export async function validateBranchName(name: string): Promise<void> {
  assertBranchName(name);
  // check-ref-format needs no repository and runs no project hooks or filters.
  // The fully qualified ref prevents expansion of @{-1} or revision expressions.
  await execFileAsync("git", ["check-ref-format", `refs/heads/${name}`], {
    timeout: 5000,
    maxBuffer: 8192,
  });
}
