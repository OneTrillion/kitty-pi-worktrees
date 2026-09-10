import { chmod } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { FrameDecoder, FrameSizeError, decodeRequest, encodeResponse } from "../shared/framing.ts";
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION, type Request, type Response } from "../shared/protocol.ts";
import { createRuntimeDirectory } from "./runtime.ts";

type Handler = (request: Request, signal: AbortSignal) => Response | Promise<Response>;
type ErrorCode = Extract<Response, { ok: false }>["error"]["code"];

const failure = (code: ErrorCode, message: string): Response => {
  return { version: PROTOCOL_VERSION, ok: false, error: { code, message } };
};

/** Only transport here. Git/Docker/Kitty operations must live in a trusted handler. */
export const startRequestServer = async (
  runtimeRoot: string,
  handler: Handler,
  frameTimeoutMs = 5000,
): Promise<{
  socketPath: string;
  close: () => Promise<void>;
  failure: Promise<Error>;
}> => {
  if (!Number.isSafeInteger(frameTimeoutMs) || frameTimeoutMs < 1) throw new Error("Invalid frame timeout");
  const runtime = await createRuntimeDirectory(runtimeRoot);
  const connections = new Map<Socket, AbortController>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let reportFailure: (error: Error) => void;
  // Resolves (does not reject) so an early server failure cannot cause an unhandled rejection.
  const failed = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const controller = new AbortController();
    connections.set(socket, controller);
    const decoder = new FrameDecoder(MAX_REQUEST_BYTES);
    let received = false;
    // Absolute incomplete-frame deadline, not an inactivity timeout a slow peer can reset.
    let timer = setTimeout(() => socket.destroy(), frameTimeoutMs);
    const reply = (response: Response): void => {
      if (socket.destroyed || closing) return;
      let frame: Buffer;
      try {
        frame = encodeResponse(response);
      } catch (error) {
        frame = encodeResponse(
          error instanceof FrameSizeError
            ? failure("response-too-large", "Response exceeds the protocol size limit")
            : failure("internal-error", "Supervisor produced an invalid response"),
        );
      }
      clearTimeout(timer);
      timer = setTimeout(() => socket.destroy(), frameTimeoutMs);
      socket.end(frame);
    };
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(timer);
      controller.abort();
      connections.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      if (received || closing) return;
      try {
        decoder.push(chunk);
      } catch {
        received = true;
        reply(failure("invalid-request", "Invalid supervisor request frame"));
      }
    });
    socket.on("end", () => {
      if (received || closing) return;
      received = true;
      clearTimeout(timer);
      let request: Request;
      try {
        request = decodeRequest(decoder);
      } catch {
        reply(failure("invalid-request", "Invalid supervisor request"));
        return;
      }
      const job = (async () => {
        try {
          const response = await handler(request, controller.signal);
          if (response.ok && response.op !== request.op) throw new Error("Response operation mismatch");
          reply(response);
        } catch {
          reply(failure("internal-error", "Supervisor request failed"));
        }
      })();
      pending.add(job);
      void job.then(
        () => pending.delete(job),
        (error: Error) => {
          pending.delete(job);
          reportFailure(error);
          socket.destroy();
        },
      );
    });
  });

  const close = (): Promise<void> => {
    return (closePromise ??= (async () => {
      closing = true;
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [socket, controller] of connections) {
        controller.abort();
        socket.destroy();
      }
      await stopped;
      // A handler must honor its signal; do not release locks while host work is still running.
      await Promise.allSettled(pending);
      await runtime.remove();
    })());
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(runtime.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    server.on("error", (error) => {
      reportFailure(error);
      void close().catch(reportFailure);
    });
    await chmod(runtime.socketPath, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  return { socketPath: runtime.socketPath, close, failure: failed };
};
