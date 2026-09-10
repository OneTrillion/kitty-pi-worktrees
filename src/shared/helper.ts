import { z } from "zod";
import { branchNameError } from "./branch.ts";
import { GitStateSchema } from "./git-state.ts";

const path = z
  .string()
  .min(1)
  .max(8192)
  .startsWith("/")
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const location = z.strictObject({ worktreePath: path, gitDir: path, commonGitDir: path });
export type GitLocation = z.infer<typeof location>;
const branch = z.string().refine((value) => branchNameError(value) === undefined);
// Internal image worker input; NOT an operation or path capability accepted by the host socket.
export const HelperRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("inspect"), location }),
  z.strictObject({
    op: z.literal("create"),
    location,
    destination: path,
    branch,
    source: z.strictObject({
      branch: z.string().nullable(),
      head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    }),
  }),
]);
export type HelperRequest = z.infer<typeof HelperRequestSchema>;
export const HelperReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), state: GitStateSchema.nullable() }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1).max(4000) }),
]);
export type HelperReply = z.infer<typeof HelperReplySchema>;
