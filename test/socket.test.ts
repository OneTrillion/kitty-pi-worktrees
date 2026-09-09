import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { prepareRuntimeRoot } from "../src/host/runtime.ts";
import { startRequestServer } from "../src/host/server.ts";
import { requestSupervisor } from "../src/shared/client.ts";
import { FrameDecoder, decodeResponse, encodeRequest, encodeResponse } from "../src/shared/framing.ts";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, type Request, type Response } from "../src/shared/protocol.ts";

const list: Request = { version: 1, op: "list" };
const listed: Response = { version: 1, ok: true, op: "list", worktrees: [] };
async function runtimeRoot(t: TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pw-sock-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return prepareRuntimeRoot(join(base, "run"));
}
function rawFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function responseFrom(frame: Buffer): Response {
  const decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
  decoder.push(frame);
  return decodeResponse(decoder);
}
async function connect(t: TestContext, path: string): Promise<Socket> {
  const socket = createConnection({ path, allowHalfOpen: true });
  socket.on("error", () => {});
  t.after(() => { socket.destroy(); });
  await once(socket, "connect");
  return socket;
}
function receive(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => parts.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(parts)));
    socket.once("close", () => resolve(Buffer.concat(parts)));
    socket.once("error", reject);
  });
}

function receiveUntilClosed(socket: Socket): Promise<Buffer> {
  // Destroying a socket with unread data may reset it rather than produce EOF.
  return receive(socket).catch((error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ECONNRESET");
    return Buffer.alloc(0);
  });
}

// A deliberately nonconforming peer for client-side validation checks.
async function fakeServer(t: TestContext, respond: (socket: Socket) => void): Promise<string> {
  const root = await runtimeRoot(t);
  const path = join(root, "fake");
  const connections = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    socket.resume();
    socket.on("end", () => respond(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return path;
}

test("real server/client round trip and private socket lifecycle", async (t) => {
  const root = await runtimeRoot(t);
  const server = await startRequestServer(root, () => listed);
  t.after(server.close);
  assert.equal((await lstat(server.socketPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(server.socketPath))).mode & 0o777, 0o700);
  assert.deepEqual(await requestSupervisor(server.socketPath, list), listed);
  await server.close();
  await server.close();
  assert.deepEqual(await readdir(root), []);
});

test("all four operation shapes reach the handler; errors round trip without retries", async (t) => {
  const root = await runtimeRoot(t);
  const seen: Request[] = [];
  const unavailable: Response = { version: 1, ok: false, error: { code: "unavailable", message: "Not implemented yet" } };
  const server = await startRequestServer(root, (request) => { seen.push(request); return unavailable; });
  t.after(server.close);
  const requests: Request[] = [list, { version: 1, op: "create-or-open", branch: "café/docs" },
    { version: 1, op: "open", worktreeId: "a".repeat(64) }, { version: 1, op: "inspect", worktreeId: "a".repeat(64) }];
  for (const request of requests) assert.deepEqual(await requestSupervisor(server.socketPath, request), unavailable);
  assert.deepEqual(seen, requests);
});

test("dispatch waits for EOF even after a complete valid frame", async (t) => {
  let calls = 0;
  const server = await startRequestServer(await runtimeRoot(t), () => { calls++; return listed; });
  t.after(server.close);
  const socket = await connect(t, server.socketPath);
  const received = receive(socket);
  for (const byte of encodeRequest(list)) socket.write(Buffer.from([byte]));
  await delay(30);
  assert.equal(calls, 0);
  socket.end();
  assert.deepEqual(responseFrom(await received), listed);
  assert.equal(calls, 1);
});

test("malformed, excessive, extra-field and multi-frame requests never dispatch", async (t) => {
  let calls = 0;
  const server = await startRequestServer(await runtimeRoot(t), () => { calls++; return listed; });
  t.after(server.close);
  const tooLarge = Buffer.alloc(4);
  tooLarge.writeUInt32BE(MAX_REQUEST_BYTES + 1);
  const frame = encodeRequest(list);
  for (const bytes of [
    tooLarge, Buffer.alloc(0), frame.subarray(0, frame.length - 1), Buffer.concat([frame, frame]),
    rawFrame({ ...list, command: "touch /tmp/never-run" }), rawFrame({ version: 9, op: "list" }),
    rawFrame({ version: 1, op: "create-or-open", branch: "x;id" }), rawFrame(null),
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

test("incomplete-frame deadline is absolute despite ongoing partial input", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const server = await startRequestServer(await runtimeRoot(t), () => { calls++; return listed; }, 80);
  t.after(server.close);
  const socket = await connect(t, server.socketPath);
  const received = receiveUntilClosed(socket);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(10000);
  socket.write(header);
  const interval = setInterval(() => socket.write(" "), 10);
  try { assert.equal((await received).length, 0); }
  finally { clearInterval(interval); }
  assert.equal(calls, 0);
});

test("handler failures and invalid responses are contained without leaking exception text", async (t) => {
  const root = await runtimeRoot(t);
  for (const handler of [
    () => { throw new Error("SECRET OR TERMINAL ESCAPE"); },
    () => ({ ...listed, arbitrary: "SECRET" }) as Response,
    () => ({ version: 1, ok: true, op: "inspect" }) as Response,
  ]) {
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
  const item = {
    id: "a".repeat(64), path: "/" + "a".repeat(8000), branch: null, head: null,
    upstream: null, open: false, locked: false, lockReason: null, prunable: true,
    pruneReason: "missing", inspection: "unavailable" as const, error: "missing",
  };
  const server = await startRequestServer(await runtimeRoot(t), () => ({
    version: 1, ok: true, op: "list", worktrees: Array.from({ length: 150 }, () => item),
  }));
  t.after(server.close);
  const response = await requestSupervisor(server.socketPath, list);
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, "response-too-large");
});

test("shutdown aborts handlers and waits for them before deleting the socket directory", { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const finishHandler = Promise.withResolvers<void>();
  const server = await startRequestServer(await runtimeRoot(t), async (_request, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await finishHandler.promise;
    return listed;
  });
  t.after(() => { finishHandler.resolve(); return server.close(); });
  const client = assert.rejects(requestSupervisor(server.socketPath, list));
  await started.promise;
  let closed = false;
  const shutdown = server.close().then(() => { closed = true; });
  await aborted.promise;
  assert.equal(closed, false);
  assert.ok((await lstat(dirname(server.socketPath))).isDirectory());
  finishHandler.resolve();
  await shutdown;
  await client;
  await assert.rejects(lstat(dirname(server.socketPath)), { code: "ENOENT" });
});

test("client rejects malformed, truncated, excessive, trailing and mismatched responses", async (t) => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_RESPONSE_BYTES + 1);
  const frame = encodeResponse(listed);
  for (const bytes of [
    oversized, frame.subarray(0, frame.length - 1), Buffer.concat([frame, Buffer.from("x")]),
    rawFrame({ ...listed, command: "id" }), rawFrame({ ...listed, version: 2 }),
    rawFrame({ version: 1, ok: true, op: "inspect" }), Buffer.alloc(0),
  ]) {
    const path = await fakeServer(t, (socket) => socket.end(bytes));
    await assert.rejects(requestSupervisor(path, list, { timeoutMs: 1000 }), /Invalid supervisor response/);
  }
});

test("client rejects a structurally valid response for a different operation", async (t) => {
  const path = await fakeServer(t, (socket) => socket.end(encodeResponse(listed)));
  await assert.rejects(requestSupervisor(path, { version: 1, op: "open", worktreeId: "a".repeat(64) }), /Invalid supervisor response/);
});

test("simultaneous connections run independently without a request count limit", async (t) => {
  let calls = 0;
  const allStarted = Promise.withResolvers<void>();
  const server = await startRequestServer(await runtimeRoot(t), async () => {
    if (++calls === 8) allStarted.resolve();
    await allStarted.promise;
    return listed;
  });
  t.after(() => { allStarted.resolve(); return server.close(); });
  const responses = await Promise.all(Array.from({ length: 8 }, () => requestSupervisor(server.socketPath, list, { timeoutMs: 2000 })));
  assert.equal(calls, 8);
  for (const response of responses) assert.deepEqual(response, listed);
});

test("shutdown destroys incomplete connections without dispatching them", async (t) => {
  let calls = 0;
  const server = await startRequestServer(await runtimeRoot(t), () => { calls++; return listed; });
  t.after(server.close);
  const socket = await connect(t, server.socketPath);
  const received = receiveUntilClosed(socket);
  socket.write(encodeRequest(list)); // Deliberately do not send EOF.
  await server.close();
  assert.equal((await received).length, 0);
  assert.equal(calls, 0);
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
  await assert.rejects(requestSupervisor(path, { ...list, version: 2 } as never));
});
