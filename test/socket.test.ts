import assert from "node:assert/strict";

import { lstat, readdir } from "node:fs/promises";

import { dirname } from "node:path";

import test from "node:test";

import { setTimeout as delay } from "node:timers/promises";

import { startRequestServer } from "../src/host/server.ts";

import { requestSupervisor } from "../src/shared/client.ts";

import { encodeRequest } from "../src/shared/framing.ts";

import { type Request, type Response } from "../src/shared/protocol.ts";
import {
  connect,
  list,
  listed,
  receive,
  receiveUntilClosed,
  responseFrom,
  runtimeRoot,
} from "./fixtures/socket.ts";

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
  const unavailable: Response = {
    version: 1,
    ok: false,
    error: { code: "unavailable", message: "Not implemented yet" },
  };
  const server = await startRequestServer(root, (request) => {
    seen.push(request);
    return unavailable;
  });
  t.after(server.close);
  const requests: Request[] = [
    list,
    { version: 1, op: "create-or-open", branch: "café/docs" },
    { version: 1, op: "open", worktreeId: "a".repeat(64) },
    { version: 1, op: "inspect", worktreeId: "a".repeat(64) },
  ];
  for (const request of requests)
    assert.deepEqual(await requestSupervisor(server.socketPath, request), unavailable);
  assert.deepEqual(seen, requests);
});

test("dispatch waits for EOF even after a complete valid frame", async (t) => {
  let calls = 0;
  const server = await startRequestServer(await runtimeRoot(t), () => {
    calls++;
    return listed;
  });
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

test("incomplete-frame deadline is absolute despite ongoing partial input", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const server = await startRequestServer(
    await runtimeRoot(t),
    () => {
      calls++;
      return listed;
    },
    80,
  );
  t.after(server.close);
  const socket = await connect(t, server.socketPath);
  const received = receiveUntilClosed(socket);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(10000);
  socket.write(header);
  const interval = setInterval(() => socket.write(" "), 10);
  try {
    assert.equal((await received).length, 0);
  } finally {
    clearInterval(interval);
  }
  assert.equal(calls, 0);
});

test(
  "shutdown aborts handlers and waits for them before deleting the socket directory",
  { timeout: 5000 },
  async (t) => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const finishHandler = Promise.withResolvers<void>();
    const server = await startRequestServer(await runtimeRoot(t), async (_request, signal) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      await finishHandler.promise;
      return listed;
    });
    t.after(() => {
      finishHandler.resolve();
      return server.close();
    });
    const client = assert.rejects(requestSupervisor(server.socketPath, list));
    await started.promise;
    let closed = false;
    const shutdown = server.close().then(() => {
      closed = true;
    });
    await aborted.promise;
    assert.equal(closed, false);
    assert.ok((await lstat(dirname(server.socketPath))).isDirectory());
    finishHandler.resolve();
    await shutdown;
    await client;
    await assert.rejects(lstat(dirname(server.socketPath)), { code: "ENOENT" });
  },
);

test("simultaneous connections run independently without a request count limit", async (t) => {
  let calls = 0;
  const allStarted = Promise.withResolvers<void>();
  const server = await startRequestServer(await runtimeRoot(t), async () => {
    if (++calls === 8) allStarted.resolve();
    await allStarted.promise;
    return listed;
  });
  t.after(() => {
    allStarted.resolve();
    return server.close();
  });
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => requestSupervisor(server.socketPath, list, { timeoutMs: 2000 })),
  );
  assert.equal(calls, 8);
  for (const response of responses) assert.deepEqual(response, listed);
});

test("shutdown destroys incomplete connections without dispatching them", async (t) => {
  let calls = 0;
  const server = await startRequestServer(await runtimeRoot(t), () => {
    calls++;
    return listed;
  });
  t.after(server.close);
  const socket = await connect(t, server.socketPath);
  const received = receiveUntilClosed(socket);
  socket.write(encodeRequest(list)); // Deliberately do not send EOF.
  await server.close();
  assert.equal((await received).length, 0);
  assert.equal(calls, 0);
});
