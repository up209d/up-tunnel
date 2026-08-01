/**
 * Wire protocol v1 — see docs/PROTOCOL.md.
 *
 * This is an independent implementation, not an import from the server: the client is
 * installable on its own and must not drag the server package along. `docs/PROTOCOL.md`
 * is the contract both sides answer to, and `test/protocol.test.ts` checks this encoder
 * against the shared byte vectors in `tests/protocol-vectors.json` — the same vectors the
 * Python client is tested against. Change the protocol there first.
 */

export const PROTOCOL_VERSION = 1;

export const FrameType = {
  Hello: 0x01,
  HelloOk: 0x02,
  Error: 0x03,
  OpenTunnel: 0x10,
  TunnelOk: 0x11,
  CloseTunnel: 0x12,
  StreamOpen: 0x20,
  StreamData: 0x21,
  StreamEof: 0x22,
  StreamAck: 0x23,
  StreamReset: 0x24,
} as const;

export const FRAME_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(FrameType).map(([name, value]) => [value, name]),
);

const STREAM_FRAME_FLOOR = 0x20;

export class ProtocolError extends Error {}

export function encodeControl(type: number, body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const out = Buffer.allocUnsafe(1 + json.length);
  out[0] = type;
  json.copy(out, 1);
  return out;
}

export function encodeStreamJson(type: number, streamId: number, body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const out = Buffer.allocUnsafe(5 + json.length);
  out[0] = type;
  out.writeUInt32BE(streamId, 1);
  json.copy(out, 5);
  return out;
}

export function encodeStreamData(streamId: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out[0] = FrameType.StreamData;
  out.writeUInt32BE(streamId, 1);
  payload.copy(out, 5);
  return out;
}

/** For frames whose whole payload is the stream id, e.g. STREAM_EOF. */
export function encodeStreamOnly(type: number, streamId: number): Buffer {
  const out = Buffer.allocUnsafe(5);
  out[0] = type;
  out.writeUInt32BE(streamId, 1);
  return out;
}

export function encodeStreamAck(streamId: number, bytes: number): Buffer {
  const out = Buffer.allocUnsafe(9);
  out[0] = FrameType.StreamAck;
  out.writeUInt32BE(streamId, 1);
  out.writeUInt32BE(bytes, 5);
  return out;
}

export type Frame =
  | { kind: "control"; type: number; body: Record<string, unknown> }
  | { kind: "stream"; type: number; streamId: number; payload: Buffer };

export function decodeFrame(buf: Buffer): Frame {
  if (buf.length < 1) throw new ProtocolError("empty frame");
  const type = buf[0]!;

  if (type < STREAM_FRAME_FLOOR) {
    let body: unknown = {};
    if (buf.length > 1) {
      try {
        body = JSON.parse(buf.subarray(1).toString("utf8"));
      } catch {
        throw new ProtocolError(`frame 0x${type.toString(16)} has a malformed JSON body`);
      }
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ProtocolError(`frame 0x${type.toString(16)} body must be a JSON object`);
    }
    return { kind: "control", type, body: body as Record<string, unknown> };
  }

  if (buf.length < 5) {
    throw new ProtocolError(`stream frame 0x${type.toString(16)} is missing its stream id`);
  }
  return { kind: "stream", type, streamId: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

/** Parses the JSON tail of a stream frame that carries one (STREAM_OPEN, STREAM_RESET). */
export function streamFrameJson(payload: Buffer): Record<string, unknown> {
  if (payload.length === 0) return {};
  try {
    const parsed = JSON.parse(payload.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
