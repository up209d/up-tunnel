"""Wire protocol v1 — see docs/PROTOCOL.md.

Deliberately dependency-free and written with no comprehensions over large buffers so the
same file can be lifted into MicroPython for an ESP32 client later.
"""

import json
import struct

PROTOCOL_VERSION = 1

HELLO = 0x01
HELLO_OK = 0x02
ERROR = 0x03
OPEN_TUNNEL = 0x10
TUNNEL_OK = 0x11
CLOSE_TUNNEL = 0x12
STREAM_OPEN = 0x20
STREAM_DATA = 0x21
STREAM_EOF = 0x22
STREAM_ACK = 0x23
STREAM_RESET = 0x24

STREAM_FRAME_FLOOR = 0x20

NAMES = {
    HELLO: "HELLO",
    HELLO_OK: "HELLO_OK",
    ERROR: "ERROR",
    OPEN_TUNNEL: "OPEN_TUNNEL",
    TUNNEL_OK: "TUNNEL_OK",
    CLOSE_TUNNEL: "CLOSE_TUNNEL",
    STREAM_OPEN: "STREAM_OPEN",
    STREAM_DATA: "STREAM_DATA",
    STREAM_EOF: "STREAM_EOF",
    STREAM_ACK: "STREAM_ACK",
    STREAM_RESET: "STREAM_RESET",
}


class ProtocolError(Exception):
    pass


def control(frame_type: int, body: dict) -> bytes:
    return bytes([frame_type]) + json.dumps(body).encode("utf-8")


def stream_json(frame_type: int, stream_id: int, body: dict) -> bytes:
    return (
        bytes([frame_type])
        + struct.pack(">I", stream_id)
        + json.dumps(body).encode("utf-8")
    )


def stream_data(stream_id: int, payload: bytes) -> bytes:
    return bytes([STREAM_DATA]) + struct.pack(">I", stream_id) + payload


def stream_only(frame_type: int, stream_id: int) -> bytes:
    return bytes([frame_type]) + struct.pack(">I", stream_id)


def stream_ack(stream_id: int, consumed: int) -> bytes:
    return bytes([STREAM_ACK]) + struct.pack(">II", stream_id, consumed)


def decode(buf: bytes):
    """Returns (frame_type, stream_id_or_None, body_or_payload).

    Control frames yield a parsed dict; stream frames yield the raw payload bytes.
    """
    if not buf:
        raise ProtocolError("empty frame")
    frame_type = buf[0]

    if frame_type < STREAM_FRAME_FLOOR:
        if len(buf) == 1:
            return frame_type, None, {}
        try:
            body = json.loads(buf[1:].decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ProtocolError("malformed JSON in frame 0x%02x" % frame_type) from exc
        if not isinstance(body, dict):
            raise ProtocolError("frame 0x%02x body must be an object" % frame_type)
        return frame_type, None, body

    if len(buf) < 5:
        raise ProtocolError("stream frame 0x%02x is missing its id" % frame_type)
    (stream_id,) = struct.unpack(">I", buf[1:5])
    return frame_type, stream_id, buf[5:]


def payload_json(payload: bytes) -> dict:
    """Parses the JSON tail of STREAM_OPEN / STREAM_RESET; tolerates an empty tail."""
    if not payload:
        return {}
    try:
        body = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}
    return body if isinstance(body, dict) else {}
