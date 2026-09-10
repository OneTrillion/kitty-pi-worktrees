import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameDecoder,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
} from "../src/shared/framing.ts";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  type Request,
  type Response,
  type Worktree,
} from "../src/shared/protocol.ts";

const request: Request = { version: 1, op: "create-or-open", branch: "café/修正" };
const rawFrame = (body: Buffer): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

test("requests round trip across every possible split, including inside UTF-8 characters", () => {
  const frame = encodeRequest(request);
  for (let split = 0; split <= frame.length; split++) {
    const decoder = new FrameDecoder(MAX_REQUEST_BYTES);
    decoder.push(frame.subarray(0, split));
    decoder.push(frame.subarray(split));
    assert.deepEqual(decodeRequest(decoder), request);
  }
});

test("byte-at-a-time input and empty chunks", () => {
  const decoder = new FrameDecoder(MAX_REQUEST_BYTES);
  for (const byte of encodeRequest(request)) {
    decoder.push(Buffer.alloc(0));
    decoder.push(Buffer.from([byte]));
  }
  assert.deepEqual(decodeRequest(decoder), request);
  assert.throws(() => decoder.finish());
  assert.throws(() => decoder.push(Buffer.alloc(0)));
});

test("responses round trip with a separate larger limit", () => {
  const response: Response = { version: 1, ok: true, op: "list", worktrees: [] };
  const decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
  decoder.push(encodeResponse({ ...response, worktrees: [] }));
  assert.deepEqual(decodeResponse(decoder), response);
});

test("reject zero and excessive lengths as soon as the header arrives", () => {
  for (const size of [0, MAX_REQUEST_BYTES + 1, 0xffffffff]) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(size);
    const decoder = new FrameDecoder(MAX_REQUEST_BYTES);
    assert.throws(() => decoder.push(header), /length/);
    assert.throws(() => decoder.finish(), /closed/);
  }
  for (const size of [0, -1, Infinity, 1.5, MAX_RESPONSE_BYTES + 1]) {
    assert.throws(() => new FrameDecoder(size));
  }
});

test("reject every truncated prefix at EOF", () => {
  const frame = encodeRequest(request);
  for (let length = 0; length < frame.length; length++) {
    const decoder = new FrameDecoder(MAX_REQUEST_BYTES);
    decoder.push(frame.subarray(0, length));
    assert.throws(() => decoder.finish(), /Incomplete/);
  }
});

test("reject trailing data and multiple frames, even in a later chunk", () => {
  const frame = encodeRequest(request);
  for (const extra of [Buffer.from("x"), frame]) {
    const together = new FrameDecoder(MAX_REQUEST_BYTES);
    assert.throws(() => together.push(Buffer.concat([frame, extra])), /Trailing/);
    const separate = new FrameDecoder(MAX_REQUEST_BYTES);
    separate.push(frame);
    assert.throws(() => separate.push(extra), /Trailing/);
    assert.throws(() => separate.finish(), /closed/);
  }
});

test("reject invalid UTF-8, BOM, JSON, schemas and protocol versions", () => {
  for (const body of [
    Buffer.from([0xff]),
    Buffer.from("\ufeff{}"),
    Buffer.from("{"),
    Buffer.from("null"),
    Buffer.from('{"version":2,"op":"list"}'),
    Buffer.from('{"version":1,"op":"list","command":"id"}'),
  ]) {
    const decoder = new FrameDecoder(MAX_REQUEST_BYTES);
    decoder.push(rawFrame(body));
    assert.throws(() => decodeRequest(decoder));
  }
});

test("outbound messages also undergo schema and byte-limit validation", () => {
  assert.throws(() => encodeRequest({ ...request, branch: "../escape" }));
  assert.throws(() => encodeResponse({ version: 1, ok: true, op: "list", worktrees: [], extra: true }));
  // Many individually valid objects can still exceed the response frame limit.
  const item: Worktree = {
    id: "a".repeat(64),
    path: "/" + "a".repeat(8000),
    branch: null,
    head: null,
    upstream: null,
    open: false,
    locked: false,
    lockReason: null,
    prunable: true,
    pruneReason: "missing",
    inspection: "unavailable",
    error: "missing",
  };
  assert.throws(
    () =>
      encodeResponse({
        version: 1,
        ok: true,
        op: "list",
        worktrees: Array.from({ length: 150 }, () => item),
      }),
    /size limit/,
  );
});
