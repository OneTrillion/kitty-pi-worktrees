import { createConnection } from "node:net";
import { FrameDecoder, decodeResponse, encodeRequest } from "./framing.ts";
import { MAX_RESPONSE_BYTES, type Request, type Response } from "./protocol.ts";

/** One connection per command; no automatic retries (a timed-out operation may have run). */
export async function requestSupervisor(
  socketPath: string,
  request: Request,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  options.signal?.throwIfAborted();
  const frame = encodeRequest(request); // Reject malformed outbound requests before connecting.
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid request timeout");
  if (!socketPath) throw new Error("Supervisor socket unavailable; start Pi through the host launcher");
  return new Promise<Response>((resolve, reject) => {
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
    let settled = false;
    const finish = (error?: Error, response?: Response): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const abort = (): void => finish(new Error("Supervisor request cancelled; its outcome may be unknown"));
    const timer = setTimeout(() => finish(new Error("Supervisor request timed out; check worktrees before retrying")), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => socket.end(frame)); // Half-close: server dispatches only at EOF.
    socket.on("error", (cause) => finish(new Error("Supervisor socket unavailable; start Pi through the host launcher", { cause })));
    socket.on("data", (chunk: Buffer) => {
      try { decoder.push(chunk); }
      catch (cause) { finish(new Error("Invalid supervisor response frame", { cause })); }
    });
    socket.once("end", () => {
      if (settled) return;
      try {
        const response = decodeResponse(decoder);
        if (response.ok && response.op !== request.op) throw new Error("Response operation mismatch");
        finish(undefined, response);
      } catch (cause) { finish(new Error("Invalid supervisor response", { cause })); }
    });
    socket.once("close", () => finish(new Error("Supervisor disconnected before a complete response; outcome may be unknown")));
  });
}
