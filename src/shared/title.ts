import { z } from "zod";

const titleState = z.enum(["starting", "working", "attention", "done", "conflict", "merged", "failed"]);
export const TITLE_STATES = titleState.options;
export type TitleState = z.infer<typeof titleState>;
export const TITLE_PREFIX = "pi-worktree:";

/** Plain display data, never terminal controls, bidi overrides, or executable templates. */
export const plainText = (value: string, max = 500): string =>
  Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " "))
    .slice(0, max)
    .join("");

export const formatTitle = (state: TitleState, branch: string | null): string =>
  `${TITLE_PREFIX}${state}:${plainText(branch ?? "detached", 120)}`;

export const parseTitle = (title: string): { state: TitleState; task: string } | null => {
  const match = /^pi-worktree:([^:]+):(.*)$/su.exec(title);
  const state = titleState.safeParse(match?.[1]);
  const task = match?.[2];
  return state.success && task !== undefined ? { state: state.data, task: plainText(task, 120) } : null;
};
