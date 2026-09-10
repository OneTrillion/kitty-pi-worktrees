import assert from "node:assert/strict";

import test from "node:test";

import { startRequestServer } from "../src/host/server.ts";

import { requestSupervisor } from "../src/shared/client.ts";

import { encodeRequest, encodeResponse } from "../src/shared/framing.ts";

import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  type Response,
  type Worktree,
} from "../src/shared/protocol.ts";
import {
  connect,
  fakeServer,
  list,
  listed,
  rawFrame,
  receive,
  responseFrom,
  runtimeRoot,
} from "./fixtures/socket.ts";

test("malformed, excessive, extra-field and multi-frame requests never dispatch", async (t) => {
  let calls = 0;
  const server = await startRequestServer(await runtimeRoot(t), () => {
    calls++;
    return listed;
  });
  t.after(server.close);
  const tooLarge = Buffer.alloc(4);
  tooLarge.writeUInt32BE(MAX_REQUEST_BYTES + 1);
  const frame = encodeRequest(list);
  for (const bytes of [
    tooLarge,
    Buffer.alloc(0),
    frame.subarray(0, frame.length - 1),
    Buffer.concat([frame, frame]),
    rawFrame({ ...list, command: "touch /tmp/never-run" }),
    rawFrame({ version: 9, op: "list" }),
    rawFrame({ version: 1, op: "create-or-open", branch: "x;id" }),
    rawFrame(null),
  ]) {
    const socket = await connect(t, server.socketPath);
    const received = receive(socket);
    socket.end(bytes);
    const response = responseFrom(await received);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "invalid-request");
  }
  assert.equal(calls, 0);
});

test("handler failures and invalid responses are contained without leaking exception text", async (t) => {
  const root = await runtimeRoot(t);
  const handlers: Array<() => Response> = [
    () => {
      throw new Error("SECRET OR TERMINAL ESCAPE");
    },
    () => ({ ...listed, arbitrary: "SECRET" }),
    // @ts-expect-error Deliberately broken handler: transport must reject malformed replies.
    () => ({ version: 1, ok: true, op: "inspect" }),
  ];
  for (const handler of handlers) {
    const server = await startRequestServer(root, handler);
    t.after(server.close);
    const response = await requestSupervisor(server.socketPath, list);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "internal-error");
    assert.doesNotMatch(JSON.stringify(response), /SECRET/);
    await server.close();
  }
});

test("oversize valid responses return response-too-large, never a partial list", async (t) => {
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
  const server = await startRequestServer(await runtimeRoot(t), () => ({
    version: 1,
    ok: true,
    op: "list",
    worktrees: Array.from({ length: 150 }, () => item),
  }));
  t.after(server.close);
  const response = await requestSupervisor(server.socketPath, list);
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, "response-too-large");
});

test("client rejects malformed, truncated, excessive, trailing and mismatched responses", async (t) => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_RESPONSE_BYTES + 1);
  const frame = encodeResponse(listed);
  for (const bytes of [
    oversized,
    frame.subarray(0, frame.length - 1),
    Buffer.concat([frame, Buffer.from("x")]),
    rawFrame({ ...listed, command: "id" }),
    rawFrame({ ...listed, version: 2 }),
    rawFrame({ version: 1, ok: true, op: "inspect" }),
    Buffer.alloc(0),
  ]) {
    const path = await fakeServer(t, (socket) => socket.end(bytes));
    await assert.rejects(requestSupervisor(path, list, { timeoutMs: 1000 }), /Invalid supervisor response/);
  }
});

test("client rejects a structurally valid response for a different operation", async (t) => {
  const path = await fakeServer(t, (socket) => socket.end(encodeResponse(listed)));
  await assert.rejects(
    requestSupervisor(path, { version: 1, op: "open", worktreeId: "a".repeat(64) }),
    /Invalid supervisor response/,
  );
});

test("client deadlines, cancellation, and unavailable sockets fail with useful errors", async (t) => {
  const path = await fakeServer(t, () => {});
  await assert.rejects(requestSupervisor(path, list, { timeoutMs: 30 }), /timed out/);
  const controller = new AbortController();
  const cancelled = assert.rejects(requestSupervisor(path, list, { signal: controller.signal }), /cancelled/);
  controller.abort();
  await cancelled;
  await assert.rejects(requestSupervisor(path, list, { signal: AbortSignal.abort() }));
  await assert.rejects(requestSupervisor(path + "-missing", list), /host launcher/);
  await assert.rejects(requestSupervisor("", list), /host launcher/);
  await assert.rejects(requestSupervisor(path, list, { timeoutMs: 0 }), /timeout/);
  // @ts-expect-error Runtime validation must also protect untyped callers.
  await assert.rejects(requestSupervisor(path, { ...list, version: 2 }));
});
