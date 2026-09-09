import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import test from "node:test";
import { validateBranchName } from "../src/host/branch.ts";
import { deriveWorktreePath, worktreeDirectoryName, worktreeId } from "../src/host/paths.ts";
import { branchNameError, MAX_BRANCH_BYTES } from "../src/shared/branch.ts";

const valid = ["main", "feature/payments", "feature/payments/docs", "v1.2", "task_1", "fix+api", "user@task", "a=b", "a,b", "a]b", "café/修正", "a/-b", "a./b"];
const invalid = ["", "HEAD", "@", "-option", "/tmp/pwn", "../task", "a/../b", "a..b", "a//b", "a/", ".hidden", "a/.hidden", "a.lock", "a.lock/b", "a.", "@{-1}", "a b", "a\nb", "a\0b", "a\u001bb", "a\u007fb", "a\u202eb", "a\u00a0b", "x~1", "x^", "x:y", "x?y", "x*y", "x[y", "x\\y", "x;id", "$(id)", "x`id`", "x|id", "x&y", "x>y", "x<y", "x'y", 'x"y', "x(y)", "x{y}", "x!y", "x#y", "\ud800"];

for (const name of valid) {
  test(`accept literal branch ${name}`, async () => {
    assert.equal(branchNameError(name), undefined);
    await validateBranchName(name);
    // Compare with Git's own branch check as well as our fully-qualified check.
    execFileSync("git", ["check-ref-format", "--branch", name]);
  });
}
for (const name of invalid) {
  test(`reject branch ${JSON.stringify(name)}`, async () => {
    assert.equal(typeof branchNameError(name), "string");
    await assert.rejects(validateBranchName(name));
    assert.throws(() => worktreeDirectoryName(name));
  });
}

test("branch size limit counts bytes, not characters", () => {
  assert.equal(branchNameError("a".repeat(MAX_BRANCH_BYTES)), undefined);
  assert.equal(branchNameError("é".repeat(MAX_BRANCH_BYTES / 2)), undefined);
  assert.ok(branchNameError("é".repeat(MAX_BRANCH_BYTES / 2 + 1)));
});

test("directory names are bounded, deterministic and confined lexically to the trusted root", () => {
  for (const name of [...valid, "a".repeat(MAX_BRANCH_BYTES)]) {
    const path = deriveWorktreePath("/trusted/tasks", name);
    assert.equal(dirname(path), "/trusted/tasks");
    assert.match(basename(path), /^wt-[a-zA-Z0-9_-]+-[a-f0-9]{64}$/);
    assert.ok(Buffer.byteLength(basename(path)) < 255);
    assert.equal(path, deriveWorktreePath("/trusted/tasks", name));
  }
  assert.throws(() => deriveWorktreePath("relative", "main"));
});

test("slug collisions, case differences, Unicode normalization and truncated prefixes remain distinct", () => {
  const names = ["a/b", "a-b", "a+b", "A/B", "café", "cafe\u0301", `${"a".repeat(100)}/one`, `${"a".repeat(100)}/two`];
  assert.equal(new Set(names.map(worktreeDirectoryName)).size, names.length);
});

test("worktree identity is a deterministic opaque hash of a canonical absolute path", () => {
  assert.match(worktreeId("/repo/main"), /^[a-f0-9]{64}$/);
  assert.equal(worktreeId("/repo/main"), worktreeId("/repo/main"));
  assert.notEqual(worktreeId("/repo/main"), worktreeId("/other/main"));
  assert.throws(() => worktreeId("relative"));
});
