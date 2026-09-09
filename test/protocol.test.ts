import assert from "node:assert/strict";
import test from "node:test";
import { RequestSchema, ResponseSchema, type Request, type Worktree } from "../src/shared/protocol.js";

const id = "a".repeat(64);
export const requests: Request[] = [
  { version: 1, op: "create-or-open", branch: "feature/payments" },
  { version: 1, op: "list" },
  { version: 1, op: "open", worktreeId: id },
  { version: 1, op: "inspect", worktreeId: id },
];
const worktree: Worktree = {
  id, path: "/repo/tasks/payments", branch: "feature/payments", head: "b".repeat(40),
  upstream: { ref: "refs/heads/main", kind: "local", exists: true },
  open: false, locked: false, lockReason: null, prunable: false, pruneReason: null,
  inspection: "ok", status: "ahead", dirty: false, conflicts: false, operation: null,
};

test("all four request operations round trip without coercion", () => {
  for (const request of requests) assert.deepEqual(RequestSchema.parse(request), request);
});

test("reject unknown or capability-expanding request fields on every operation", () => {
  for (const request of requests) {
    for (const key of ["path", "cwd", "command", "args", "image", "mounts", "dockerArgs", "kittyTarget", "tabId", "sourceBranch", "__proto__"]) {
      assert.equal(RequestSchema.safeParse({ ...request, [key]: "untrusted" }).success, false, key);
    }
  }
});

test("reject missing fields, wrong types, versions, operations and nonopaque identities", () => {
  for (const value of [null, [], "list", {}, { version: "1", op: "list" },
    { version: 2, op: "list" }, { version: 1, op: "exec" },
    { version: 1, op: "create-or-open" }, { version: 1, op: "create-or-open", branch: 42 },
    { version: 1, op: "create-or-open", branch: "x;id" },
    ...["/tmp/path", "../path", "main", "g".repeat(64), "a".repeat(63)].map((worktreeId) => ({ version: 1, op: "open", worktreeId })),
  ]) assert.equal(RequestSchema.safeParse(value).success, false, JSON.stringify(value));
});

test("strict successful and error responses", () => {
  const responses = [
    { version: 1, ok: true, op: "create-or-open", outcome: "created", worktree },
    { version: 1, ok: true, op: "open", outcome: "reopened", worktree },
    { version: 1, ok: true, op: "inspect", worktree },
    { version: 1, ok: true, op: "list", worktrees: [worktree] },
    { version: 1, ok: false, error: { code: "git-error", message: "Git failed" } },
  ];
  for (const response of responses) {
    assert.deepEqual(ResponseSchema.parse(response), response);
    assert.equal(ResponseSchema.safeParse({ ...response, extra: true }).success, false);
  }
  assert.equal(ResponseSchema.safeParse({ version: 1, ok: true, op: "open", outcome: "created", worktree }).success, false);
  assert.equal(ResponseSchema.safeParse({ version: 1, ok: false, error: { code: "git-error", message: "x", command: "id" } }).success, false);
});

test("unavailable entries cannot claim a clean status; nested data is strict", () => {
  const { status: _status, dirty: _dirty, conflicts: _conflicts, operation: _operation, ...common } = worktree;
  const unavailable = { ...common, inspection: "unavailable", error: "Worktree directory is missing", prunable: true };
  const response = (item: unknown) => ({ version: 1, ok: true, op: "inspect", worktree: item });
  assert.equal(ResponseSchema.safeParse(response(unavailable)).success, true);
  for (const item of [
    { ...unavailable, status: "clean" }, { ...worktree, status: "done" },
    { ...worktree, path: "../repo" }, { ...worktree, dirty: "false" },
    { ...worktree, upstream: { ...worktree.upstream, command: "id" } },
  ]) assert.equal(ResponseSchema.safeParse(response(item)).success, false);
});
