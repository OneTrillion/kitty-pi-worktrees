import { z } from "zod";
import { branchNameError } from "./branch.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

const version = z.literal(PROTOCOL_VERSION);
const worktreeId = z.string().regex(/^[a-f0-9]{64}$/);
const branch = z.string().superRefine((name, ctx) => {
  const message = branchNameError(name);
  if (message) ctx.addIssue({ code: "custom", message });
});

export const RequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ version, op: z.literal("create-or-open"), branch }),
  z.strictObject({ version, op: z.literal("list") }),
  z.strictObject({ version, op: z.literal("open"), worktreeId }),
  z.strictObject({ version, op: z.literal("inspect"), worktreeId }),
]);
export type Request = z.infer<typeof RequestSchema>;

export const WorktreeStatusSchema = z.enum([
  "conflict",
  "dirty",
  "upstream-gone",
  "merged",
  "needs-sync",
  "ahead",
  "clean",
]);
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

// These strings are display data, NOT commands/paths accepted back from the client.
// Existing Git names need not satisfy the stricter create-by-name protocol policy.
const text = z.string().max(8192);
const upstream = z.strictObject({
  ref: text,
  kind: z.enum(["local", "remote"]),
  exists: z.boolean(),
});
const commonWorktreeFields = {
  id: worktreeId,
  path: text.min(1).startsWith("/"),
  branch: text.min(1).nullable(), // null for detached HEAD
  head: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .nullable(),
  upstream: upstream.nullable(),
  open: z.boolean(), // runtime lock, independent of Git status
  locked: z.boolean(), // Git administrative worktree lock
  lockReason: text.nullable(),
  prunable: z.boolean(),
  pruneReason: text.nullable(),
};

// Unreadable/prunable entries must never masquerade as clean worktrees.
export const WorktreeSchema = z.discriminatedUnion("inspection", [
  z.strictObject({
    ...commonWorktreeFields,
    inspection: z.literal("ok"),
    status: WorktreeStatusSchema,
    dirty: z.boolean(),
    conflicts: z.boolean(),
    operation: z.enum(["merge", "rebase"]).nullable(),
  }),
  z.strictObject({
    ...commonWorktreeFields,
    inspection: z.literal("unavailable"),
    error: text.min(1),
  }),
]);
export type Worktree = z.infer<typeof WorktreeSchema>;

const success = { version, ok: z.literal(true) };
export const ResponseSchema = z.union([
  z.strictObject({
    ...success,
    op: z.literal("create-or-open"),
    outcome: z.enum(["created", "reopened", "already-active"]),
    worktree: WorktreeSchema,
  }),
  z.strictObject({ ...success, op: z.literal("list"), worktrees: z.array(WorktreeSchema) }),
  z.strictObject({
    ...success,
    op: z.literal("open"),
    outcome: z.enum(["reopened", "already-active"]),
    worktree: WorktreeSchema,
  }),
  z.strictObject({ ...success, op: z.literal("inspect"), worktree: WorktreeSchema }),
  z.strictObject({
    version,
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "invalid-request",
        "not-found",
        "git-error",
        "path-collision",
        "kitty-error",
        "unavailable",
        "internal-error",
        "response-too-large",
      ]),
      message: text.min(1),
    }),
  }),
]);
export type Response = z.infer<typeof ResponseSchema>;
