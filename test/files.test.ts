import assert from "node:assert/strict";
import test from "node:test";
import { containsPath, pathsOverlap } from "../src/host/files.ts";

test("canonical path containment respects directory boundaries, including filesystem root", () => {
  for (const [parent, child] of [
    ["/", "/"],
    ["/", "/home/task"],
    ["/home/task", "/home/task"],
    ["/home/task", "/home/task/file"],
  ]) {
    assert.ok(parent && child);
    assert.equal(containsPath(parent, child), true);
    assert.equal(pathsOverlap(parent, child), true);
    assert.equal(pathsOverlap(child, parent), true);
  }
  assert.equal(containsPath("/home/task", "/home/tasks"), false);
  assert.equal(containsPath("/home/task", "/home"), false);
  assert.equal(pathsOverlap("/home/task", "/home/tasks"), false);
});
