export const TITLE_STATES = ["starting", "working", "attention", "done", "conflict", "merged", "failed"] as const;
export type TitleState = typeof TITLE_STATES[number];
export const TITLE_PREFIX = "pi-worktree:";

/** Plain display data, never terminal controls, bidi overrides, or executable templates. */
export function plainText(value: string, max = 500): string {
  return Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")).slice(0, max).join("");
}
export function formatTitle(state: TitleState, branch: string | null): string {
  return `${TITLE_PREFIX}${state}:${plainText(branch ?? "detached", 120)}`;
}
export function parseTitle(title: string): { state: TitleState; task: string } | null {
  const match = /^pi-worktree:(starting|working|attention|done|conflict|merged|failed):(.*)$/su.exec(title);
  return match ? { state: match[1] as TitleState, task: plainText(match[2]!, 120) } : null;
}
