import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  FrameType,
  ProtocolError,
  decodeFrame,
  encodeStreamAck,
  encodeStreamData,
  encodeStreamOnly,
  streamFrameJson,
} from "../src/protocol.js";
import { rewriteHostHeader } from "../src/stream.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, "..", "..", "tests", "protocol-vectors.json"), "utf8"),
);

const hex = (buf: Buffer) => buf.toString("hex");
const unhex = (s: string) => Buffer.from(s, "hex");

test("frame type numbers match the shared vectors", () => {
  const expected: Record<string, number> = vectors.frameTypes;
  const actual: Record<string, number> = {
    HELLO: FrameType.Hello,
    HELLO_OK: FrameType.HelloOk,
    ERROR: FrameType.Error,
    OPEN_TUNNEL: FrameType.OpenTunnel,
    TUNNEL_OK: FrameType.TunnelOk,
    CLOSE_TUNNEL: FrameType.CloseTunnel,
    STREAM_OPEN: FrameType.StreamOpen,
    STREAM_DATA: FrameType.StreamData,
    STREAM_EOF: FrameType.StreamEof,
    STREAM_ACK: FrameType.StreamAck,
    STREAM_RESET: FrameType.StreamReset,
  };
  assert.deepEqual(actual, expected);
});

test("encoders produce the exact bytes in the vectors", () => {
  for (const v of vectors.encode) {
    let frame: Buffer;
    switch (v.kind) {
      case "stream_data":
        frame = encodeStreamData(v.streamId, unhex(v.payloadHex));
        break;
      case "stream_only":
        frame = encodeStreamOnly(v.type, v.streamId);
        break;
      case "stream_ack":
        frame = encodeStreamAck(v.streamId, v.bytes);
        break;
      default:
        throw new Error(`unknown vector kind ${v.kind}`);
    }
    assert.equal(hex(frame), v.hex, v.name);
  }
});

test("decoder reads the vectors back correctly", () => {
  for (const v of vectors.decode) {
    const frame = decodeFrame(unhex(v.hex));
    assert.equal(frame.kind, v.expect.kind, v.name);
    assert.equal(frame.type, v.expect.type, v.name);

    if (frame.kind === "control") {
      assert.deepEqual(frame.body, v.expect.body, v.name);
    } else {
      assert.equal(frame.streamId, v.expect.streamId, v.name);
      if (v.expect.payloadHex !== undefined) {
        assert.equal(hex(frame.payload), v.expect.payloadHex, v.name);
      }
      if (v.expect.json !== undefined) {
        assert.deepEqual(streamFrameJson(frame.payload), v.expect.json, v.name);
      }
    }
  }
});

test("decoder rejects the malformed frames in the vectors", () => {
  for (const v of vectors.decodeErrors) {
    assert.throws(() => decodeFrame(unhex(v.hex)), ProtocolError, v.name);
  }
});

test("round trip survives every byte value", () => {
  const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const frame = decodeFrame(encodeStreamData(1234, payload));
  assert.equal(frame.kind, "stream");
  assert.equal(frame.type, FrameType.StreamData);
  if (frame.kind === "stream") {
    assert.equal(frame.streamId, 1234);
    assert.deepEqual(frame.payload, payload);
  }
});

test("host rewriting matches the shared vectors", () => {
  for (const v of vectors.hostRewrite) {
    const out = rewriteHostHeader(Buffer.from(v.in, "latin1"), v.target);
    assert.equal(out.toString("latin1"), v.out, v.name);
  }
});

test("host rewriting never corrupts non-ASCII body bytes", () => {
  const head = Buffer.concat([
    Buffer.from("POST / HTTP/1.1\r\nHost: a.example.com\r\n\r\n", "latin1"),
    Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x80]),
  ]);
  const out = rewriteHostHeader(head, "127.0.0.1:3000");
  assert.deepEqual(out.subarray(out.length - 5), Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x80]));
  assert.ok(out.toString("latin1").includes("Host: 127.0.0.1:3000\r\n"));
});
