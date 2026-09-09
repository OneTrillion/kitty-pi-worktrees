import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { assertBranchName } from "../shared/branch.js";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Readable prefix plus hash of the FULL, unnormalized branch name. */
export function worktreeDirectoryName(branch: string): string {
  assertBranchName(branch);
  const slug = branch.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48);
  return `wt-${slug}-${digest(branch)}`;
}

/** Pure derivation, not authorization. Host must check real paths/symlinks and collisions. */
export function deriveWorktreePath(trustedRoot: string, branch: string): string {
  if (!isAbsolute(trustedRoot)) throw new Error("Worktree root must be absolute");
  return join(trustedRoot, worktreeDirectoryName(branch));
}

/** Caller must supply a host-canonicalized path from Git discovery, never a request. */
export function worktreeId(canonicalPath: string): string {
  if (!isAbsolute(canonicalPath)) throw new Error("Worktree identity requires an absolute path");
  return digest(canonicalPath);
}
