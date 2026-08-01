"""Checks this implementation against the shared vectors in tests/protocol-vectors.json.

Those same vectors are asserted by the Node client, so a protocol change that only lands
in one implementation fails here.

    cd client && python -m unittest discover tests
"""

import json
import os
import unittest

from uptunnel import protocol as p
from uptunnel.client import _rewrite_host_header

VECTORS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests", "protocol-vectors.json"
)

with open(VECTORS_PATH, "r", encoding="utf-8") as fh:
    VECTORS = json.load(fh)


class TestFrameTypes(unittest.TestCase):
    def test_numbers_match_shared_vectors(self):
        self.assertEqual(
            {
                "HELLO": p.HELLO,
                "HELLO_OK": p.HELLO_OK,
                "ERROR": p.ERROR,
                "OPEN_TUNNEL": p.OPEN_TUNNEL,
                "TUNNEL_OK": p.TUNNEL_OK,
                "CLOSE_TUNNEL": p.CLOSE_TUNNEL,
                "STREAM_OPEN": p.STREAM_OPEN,
                "STREAM_DATA": p.STREAM_DATA,
                "STREAM_EOF": p.STREAM_EOF,
                "STREAM_ACK": p.STREAM_ACK,
                "STREAM_RESET": p.STREAM_RESET,
            },
            VECTORS["frameTypes"],
        )

    def test_protocol_version_matches(self):
        self.assertEqual(p.PROTOCOL_VERSION, VECTORS["version"])


class TestEncode(unittest.TestCase):
    def test_produces_exact_bytes(self):
        for v in VECTORS["encode"]:
            with self.subTest(v["name"]):
                if v["kind"] == "stream_data":
                    frame = p.stream_data(v["streamId"], bytes.fromhex(v["payloadHex"]))
                elif v["kind"] == "stream_only":
                    frame = p.stream_only(v["type"], v["streamId"])
                elif v["kind"] == "stream_ack":
                    frame = p.stream_ack(v["streamId"], v["bytes"])
                else:
                    self.fail("unknown vector kind %s" % v["kind"])
                self.assertEqual(frame.hex(), v["hex"])


class TestDecode(unittest.TestCase):
    def test_reads_vectors_back(self):
        for v in VECTORS["decode"]:
            with self.subTest(v["name"]):
                frame_type, stream_id, body = p.decode(bytes.fromhex(v["hex"]))
                expect = v["expect"]
                self.assertEqual(frame_type, expect["type"])

                if expect["kind"] == "control":
                    self.assertIsNone(stream_id)
                    self.assertEqual(body, expect["body"])
                else:
                    self.assertEqual(stream_id, expect["streamId"])
                    if "payloadHex" in expect:
                        self.assertEqual(body.hex(), expect["payloadHex"])
                    if "json" in expect:
                        self.assertEqual(p.payload_json(body), expect["json"])

    def test_rejects_malformed_frames(self):
        for v in VECTORS["decodeErrors"]:
            with self.subTest(v["name"]):
                with self.assertRaises(p.ProtocolError):
                    p.decode(bytes.fromhex(v["hex"]))

    def test_round_trip_survives_every_byte_value(self):
        payload = bytes(range(256))
        frame_type, stream_id, out = p.decode(p.stream_data(1234, payload))
        self.assertEqual(frame_type, p.STREAM_DATA)
        self.assertEqual(stream_id, 1234)
        self.assertEqual(out, payload)


class TestHostRewrite(unittest.TestCase):
    def test_matches_shared_vectors(self):
        for v in VECTORS["hostRewrite"]:
            with self.subTest(v["name"]):
                out = _rewrite_host_header(v["in"].encode("latin-1"), v["target"])
                self.assertEqual(out.decode("latin-1"), v["out"])

    def test_never_corrupts_non_ascii_body_bytes(self):
        tail = bytes([0x00, 0xFF, 0xC3, 0x28, 0x80])
        head = b"POST / HTTP/1.1\r\nHost: a.example.com\r\n\r\n" + tail
        out = _rewrite_host_header(head, "127.0.0.1:3000")
        self.assertEqual(out[-5:], tail)
        self.assertIn(b"Host: 127.0.0.1:3000\r\n", out)


if __name__ == "__main__":
    unittest.main()
