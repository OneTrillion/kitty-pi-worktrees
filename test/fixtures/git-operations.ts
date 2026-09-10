import { writeFile } from "node:fs/promises";

import { join } from "node:path";

import { createGitOperations, type GitOperations } from "../../src/git/operations.ts";

import { git } from "./git.ts";

export const operations = async (path: string): Promise<GitOperations> => {
  const instance = createGitOperations({
    worktreePath: path,
    gitDir: await git(path, ["rev-parse", "--absolute-git-dir"]),
    commonGitDir: await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  });
  await instance.prepare();
  return instance;
};

export const commit = async (path: string, file: string, value: string) => {
  await writeFile(join(path, file), value);
  await git(path, ["add", file]);
  await git(path, ["commit", "-m", file]);
};
