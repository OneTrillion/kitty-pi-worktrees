export const MAX_BRANCH_BYTES = 1024;

/** Protocol policy: Git branch syntax minus shell metacharacters. Never normalize. */
export const branchNameError = (name: string): string | undefined => {
  if (name.length === 0 || Buffer.byteLength(name, "utf8") > MAX_BRANCH_BYTES) {
    return `Branch name must contain 1–${MAX_BRANCH_BYTES} UTF-8 bytes`;
  }
  if (!name.isWellFormed()) return "Branch name must be valid Unicode";
  if (name === "HEAD" || name === "@" || name.startsWith("-")) {
    return "Expected a literal local branch name, not HEAD or an option";
  }
  // Git forbids ASCII space/control, ~ ^ : ? * [ and backslash. Also reject
  // whitespace/control Unicode and shell syntax that Git itself might accept.
  if (/[\p{White_Space}\p{Cc}\p{Cf}~^:?*\[\\;$`'"|&<>(){}!#]/u.test(name)) {
    return "Branch name contains forbidden whitespace, control, or shell syntax";
  }
  if (name.includes("..") || name.includes("@{") || name.endsWith(".")) {
    return "Branch name contains invalid Git ref syntax";
  }
  if (name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    return "Branch components must be nonempty, not start with '.', and not end with '.lock'";
  }
  return undefined;
};

export const assertBranchName = (name: string): void => {
  const error = branchNameError(name);
  if (error) throw new Error(error);
};
