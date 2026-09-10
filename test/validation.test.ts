import assert from "node:assert/strict";
import test from "node:test";
import { hasErrorCode, isRecord, parseJson } from "../src/shared/validation.ts";

test("JSON stays unknown until validated, including valid non-object values", () => {
  assert.deepEqual(parseJson('{"ok":true}'), { ok: true });
  assert.equal(parseJson("null"), null);
  assert.equal(parseJson("42"), 42);
  assert.throws(() => parseJson("{"), SyntaxError);
});

test("record narrowing excludes null, arrays and primitives", () => {
  for (const value of [null, undefined, true, 0, "text", [], () => {}]) {
    assert.equal(isRecord(value), false);
  }
  assert.ok(isRecord({}));
  assert.ok(isRecord(new Error("failure")));
});

test("error codes are checked without coercion or assumptions about thrown values", () => {
  const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
  assert.ok(hasErrorCode(missing, "ENOENT"));
  assert.ok(hasErrorCode({ code: 1 }, 1));
  assert.equal(hasErrorCode({ code: "1" }, 1), false);
  for (const error of [null, undefined, "ENOENT", 1, {}, new Error("ENOENT"), ["ENOENT"]]) {
    assert.equal(hasErrorCode(error, "ENOENT"), false);
  }
});
