export interface WorktreeRecord {
  path: string; branch: string | null; head: string | null;
  locked: boolean; lockReason: string | null; prunable: boolean; pruneReason: string | null;
}

/** Git's NUL porcelain, not shell-quoted paths or an extension registry. */
export function parseWorktreeRecords(output: string): WorktreeRecord[] {
  if (!output.endsWith("\0\0")) throw new Error("Invalid Git worktree porcelain output");
  const result = output.slice(0, -2).split("\0\0").map((record): WorktreeRecord => {
    const fields = record.split("\0");
    if (!fields[0]?.startsWith("worktree /")) throw new Error("Invalid Git worktree path");
    const value = (key: string): string | null => fields.find((field) => field.startsWith(key + " "))?.slice(key.length + 1) ?? null;
    const head = value("HEAD");
    if (head && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Invalid worktree commit");
    const ref = value("branch");
    return { path: fields[0].slice(9), head, branch: ref?.startsWith("refs/heads/") ? ref.slice(11) : null,
      locked: fields.some((field) => field === "locked" || field.startsWith("locked ")), lockReason: value("locked"),
      prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")), pruneReason: value("prunable") };
  });
  if (new Set(result.map((item) => item.path)).size !== result.length) throw new Error("Duplicate Git worktree paths");
  return result;
}
