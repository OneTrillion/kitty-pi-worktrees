import { HelperReplySchema, HelperRequestSchema, type HelperReply, type HelperRequest } from "../shared/helper.ts";
import { plainText } from "../shared/title.ts";
import { GitOperations } from "./operations.ts";

/** Fixed entry point for the credential-free helper image. Never imported/executed on host projects. */
export async function runGitHelper(request: HelperRequest): Promise<HelperReply> {
  const git = new GitOperations(request.location);
  await git.prepare();
  if (request.op === "inspect") return { ok: true, state: await git.state() };
  await git.createWorktree(request.branch, request.destination, request.source);
  return { ok: true, state: null };
}

// Separate CLI file keeps imports/test execution side-effect free.
export async function helperMain(input: string): Promise<string> {
  try {
    const reply = await runGitHelper(HelperRequestSchema.parse(JSON.parse(input)));
    return JSON.stringify(HelperReplySchema.parse(reply));
  } catch (error) {
    return JSON.stringify({ ok: false, error: plainText(error instanceof Error ? error.message : "Git operation failed", 3500) || "Git operation failed" });
  }
}
