import { z } from "zod";

export const UpstreamSchema = z.strictObject({
  ref: z.string().min(1).max(8192), kind: z.enum(["local", "remote"]), exists: z.boolean(),
});
export const GitStateSchema = z.strictObject({
  branch: z.string().min(1).max(8192).nullable(),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  upstream: UpstreamSchema.nullable(),
  dirty: z.boolean(), conflicts: z.boolean(),
  operation: z.enum(["merge", "rebase"]).nullable(),
  status: z.enum(["conflict", "dirty", "upstream-gone", "merged", "needs-sync", "ahead", "clean"]),
});
export type GitState = z.infer<typeof GitStateSchema>;

export function classifyState(input: {
  dirty: boolean; conflicts: boolean; operation: string | null;
  upstream: { exists: boolean } | null; containedByUpstream: boolean; containsUpstream: boolean;
}): GitState["status"] {
  if (input.conflicts || input.operation) return "conflict";
  if (input.dirty) return "dirty";
  if (input.upstream && !input.upstream.exists) return "upstream-gone";
  if (input.upstream && input.containedByUpstream) return "merged";
  if (input.upstream && !input.containsUpstream) return "needs-sync";
  if (input.upstream) return "ahead";
  return "clean";
}

export function requireClean(state: GitState): void {
  if (state.conflicts || state.operation) throw new Error("Finish the active merge/rebase and resolve conflicts first");
  if (state.dirty) throw new Error("Commit or explicitly stash modified and untracked files first");
}
