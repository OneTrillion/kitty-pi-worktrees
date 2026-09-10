import { TextDecoder } from "node:util";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  RequestSchema,
  ResponseSchema,
  type Request,
  type Response,
} from "./protocol.ts";
import { parseJson } from "./validation.ts";

export class FrameSizeError extends Error {
  constructor() {
    super("Frame exceeds size limit");
    this.name = "FrameSizeError";
  }
}

/** A connection carries exactly one frame: uint32 BE length, then UTF-8 JSON. */
const encode = (value: unknown, maxBytes: number): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > maxBytes) throw new FrameSizeError();
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  return frame;
};

export const encodeRequest = (request: unknown): Buffer => {
  return encode(RequestSchema.parse(request), MAX_REQUEST_BYTES);
};

export const encodeResponse = (response: unknown): Buffer => {
  return encode(ResponseSchema.parse(response), MAX_RESPONSE_BYTES);
};

/**
 * Bounded single-message decoder. Call finish() at EOF, before dispatching.
 * No action is allowed on a partial frame or before trailing data is rejected.
 * The socket layer must use allowHalfOpen and enforce an incomplete-frame timeout.
 */
export class FrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  private failed = false;
  private finished = false;

  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) {
      throw new Error("Invalid frame size limit");
    }
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    if (this.failed || this.finished) throw new Error("Decoder is closed");
    try {
      let offset = 0;
      if (this.headerBytes < 4) {
        const count = Math.min(4 - this.headerBytes, chunk.length);
        chunk.copy(this.header, this.headerBytes, 0, count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < 4) return;
        const length = this.header.readUInt32BE();
        if (length === 0 || length > this.maxBytes) throw new Error("Invalid frame length");
        this.body = Buffer.allocUnsafe(length);
      }
      const body = this.body;
      if (!body) throw new Error("Incomplete frame header");
      const count = chunk.length - offset;
      if (count > body.length - this.bodyBytes) throw new Error("Trailing data after frame");
      chunk.copy(body, this.bodyBytes, offset);
      this.bodyBytes += count;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  finish(): unknown {
    if (this.failed || this.finished) throw new Error("Decoder is closed");
    this.finished = true;
    if (!this.body || this.bodyBytes !== this.body.length) throw new Error("Incomplete frame");
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.body);
    return parseJson(json);
  }
}

export const decodeRequest = (decoder: FrameDecoder): Request => {
  return RequestSchema.parse(decoder.finish());
};

export const decodeResponse = (decoder: FrameDecoder): Response => {
  return ResponseSchema.parse(decoder.finish());
};
