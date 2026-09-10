import assert from "node:assert/strict";

import { once } from "node:events";

import { mkdtemp, rm } from "node:fs/promises";

import { createConnection, createServer, type Socket } from "node:net";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { type TestContext } from "node:test";

import { prepareRuntimeRoot } from "../../src/host/runtime.ts";
import { hasErrorCode } from "../../src/shared/validation.ts";

import { FrameDecoder, decodeResponse } from "../../src/shared/framing.ts";

import { MAX_RESPONSE_BYTES, type Request, type Response } from "../../src/shared/protocol.ts";

export const list: Request = { version: 1, op: "list" };

export const listed: Response = { version: 1, ok: true, op: "list", worktrees: [] };

export const runtimeRoot = async (t: TestContext): Promise<string> => {
  const base = await mkdtemp(join(tmpdir(), "pw-sock-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return prepareRuntimeRoot(join(base, "run"));
};

export const rawFrame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

export const responseFrom = (frame: Buffer): Response => {
  const decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
  decoder.push(frame);
  return decodeResponse(decoder);
};

export const connect = async (t: TestContext, path: string): Promise<Socket> => {
  const socket = createConnection({ path, allowHalfOpen: true });
  socket.on("error", () => {});
  t.after(() => {
    socket.destroy();
  });
  await once(socket, "connect");
  return socket;
};

export const receive = (socket: Socket): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => parts.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(parts)));
    socket.once("close", () => resolve(Buffer.concat(parts)));
    socket.once("error", reject);
  });
};

export const receiveUntilClosed = (socket: Socket): Promise<Buffer> => {
  // Destroying a socket with unread data may reset it rather than produce EOF.
  return receive(socket).catch((error: unknown) => {
    assert.ok(hasErrorCode(error, "ECONNRESET"));
    return Buffer.alloc(0);
  });
};

// A deliberately nonconforming peer for client-side validation checks.
export const fakeServer = async (t: TestContext, respond: (socket: Socket) => void): Promise<string> => {
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
};
