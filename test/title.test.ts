import assert from "node:assert/strict";
import test from "node:test";
import { formatTitle, parseTitle, plainText, TITLE_STATES } from "../src/shared/title.ts";

test("every title state round trips without interpreting branch text", () => {
  for (const state of TITLE_STATES) {
    const title = formatTitle(state, "feature/{__import__('os')}/docs");
    assert.deepEqual(parseTitle(title), { state, task: "feature/{__import__('os')}/docs" });
  }
  assert.equal(parseTitle("prefix pi-worktree:done:task"), null);
  assert.equal(parseTitle("pi-worktree:arbitrary-color:task"), null);
  assert.equal(parseTitle(formatTitle("starting", null))?.task, "detached");
});

test("control/bidi/surrogate text is removed and display length is bounded", () => {
  const dangerous = "x\x1b]52;c;abc\x07\n\u009b\u202e\ud800";
  assert.doesNotMatch(plainText(dangerous), /[\p{Cc}\p{Cf}\p{Cs}]/u);
  assert.equal(Array.from(parseTitle(formatTitle("working", "修".repeat(300)))!.task).length, 120);
  assert.equal(parseTitle("pi-worktree:done:line\nbreak")?.task, "line break");
});
