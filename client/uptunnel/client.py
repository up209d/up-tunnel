"""uptunnel agent: keeps one WebSocket to the server and relays tunnelled connections."""

import asyncio
import logging
import random
import re
import socket
import ssl
from dataclasses import dataclass, field

import websockets
from websockets.exceptions import ConnectionClosed

from . import protocol as p
from .healthlog import health

VERSION = "0.1.0"
CLIENT_ID = "uptunnel-py/" + VERSION

LOCAL_READ_CHUNK = 64 * 1024
LOCAL_CONNECT_TIMEOUT = 10.0
HANDSHAKE_TIMEOUT = 15.0
MAX_HEAD_BUFFER = 32 * 1024

# Ping often enough that NAT mappings and proxy read timeouts never expire, and
# give up on a silent link within one further interval. Per-device numbers — an
# LTE modem wants different ones from a box on wired ethernet — so the
# environment overrides both (UPTUNNEL_PING_INTERVAL / UPTUNNEL_PING_TIMEOUT).
PING_INTERVAL = 20.0
PING_TIMEOUT = 20.0

RECONNECT_MIN = 1.0
RECONNECT_MAX = 60.0
# A session must stay up this long before we treat it as healthy and reset the backoff.
# Without it, a server that accepts connections and immediately drops them would be
# retried once a second forever, because every attempt technically "succeeded".
STABLE_SESSION = 30.0

log = logging.getLogger("uptunnel")


_HOST_HEADER_RE = re.compile(rb"(?im)^Host:[^\r\n]*")


def _primary_lan_ip():
    """Best guess at this host's address on its own LAN, reported in HELLO.

    Purely informational — the server logs it so a headless machine can be found
    on the network, and never routes on it. The UDP socket is not connected to
    anything: it just makes the kernel pick the interface it would use to reach
    the internet. None on a host with no route, which is fine (the field is
    optional).
    """
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 53))    # TEST-NET-1; no packet is sent
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        if s is not None:
            s.close()


def _rewrite_host_header(head: bytes, target: str) -> bytes:
    """Replaces the first Host header value, leaving the rest of the head byte-identical.

    Only the first match is replaced, so a body line that happens to look like a header is
    left alone. A head with no Host header comes back unchanged.
    """
    return _HOST_HEADER_RE.sub(b"Host: " + target.encode("ascii"), head, count=1)


class AuthError(Exception):
    """Server rejected our credentials — retrying will not help."""


@dataclass
class TunnelSpec:
    name: str
    kind: str  # "http" | "tcp"
    target_host: str
    target_port: int
    subdomain: str = ""
    remote_port: int = 0
    # Rewrite the Host header on the way to the local service. Dev servers such as Vite
    # and webpack reject requests whose Host they don't recognise.
    rewrite_host: bool = False

    @property
    def target(self) -> str:
        return "%s:%d" % (self.target_host, self.target_port)


@dataclass
class AgentConfig:
    server: str
    token: str
    name: str = "device"
    tunnels: list = field(default_factory=list)
    insecure: bool = False
    # Keepalive, in seconds. None disables that half of it: no ping at all, or a
    # ping that is sent but whose answer is never waited on.
    ping_interval: float = PING_INTERVAL
    ping_timeout: float = PING_TIMEOUT


class Stream:
    """One tunnelled connection, bridged between the WebSocket and a local socket.

    Two independent pump tasks move bytes in each direction. Neither ever blocks the
    agent's demultiplex loop: inbound frames are queued, and the queue is bounded in
    practice by the credit window the server granted us.
    """

    def __init__(self, agent: "Agent", stream_id: int, spec: TunnelSpec, window: int):
        self.agent = agent
        self.id = stream_id
        self.spec = spec
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.send_credit = window
        self.credit = asyncio.Event()
        self.credit.set()
        self.reader = None
        self.writer = None
        self.tasks: list = []
        self.finished = False
        self._head_buf = b""
        self._head_done = not (spec.kind == "http" and spec.rewrite_host)

    async def run(self) -> None:
        try:
            self.reader, self.writer = await asyncio.wait_for(
                asyncio.open_connection(self.spec.target_host, self.spec.target_port),
                LOCAL_CONNECT_TIMEOUT,
            )
        except (OSError, asyncio.TimeoutError) as exc:
            log.warning(
                "stream %d: cannot reach %s (%s)", self.id, self.spec.target, exc
            )
            self.agent.send(
                p.stream_json(
                    p.STREAM_RESET, self.id, {"code": "dial_failed", "message": str(exc)}
                )
            )
            self.finish(notify=False)
            return

        log.debug("stream %d: connected to %s", self.id, self.spec.target)
        self.tasks = [
            asyncio.create_task(self._to_local()),
            asyncio.create_task(self._to_server()),
        ]
        try:
            await asyncio.gather(*self.tasks)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - one bad stream must not kill the agent
            log.debug("stream %d: pump ended (%s)", self.id, exc)
        finally:
            self.finish()

    # ---- server -> local ----------------------------------------------------

    def feed(self, payload: bytes) -> None:
        self.inbox.put_nowait(payload)

    def feed_eof(self) -> None:
        self.inbox.put_nowait(None)

    async def _to_local(self) -> None:
        while True:
            item = await self.inbox.get()
            if item is None:
                # Anything still held back for a Host rewrite has to go out before we
                # half-close, or the local service waits forever for a request head.
                if self._head_buf:
                    self.writer.write(_rewrite_host_header(self._head_buf, self.spec.target))
                    self._head_buf = b""
                    self._head_done = True
                    await self.writer.drain()
                try:
                    if self.writer.can_write_eof():
                        self.writer.write_eof()
                except OSError:
                    pass
                return

            consumed = len(item)
            out = item if self._head_done else self._buffer_head(item)
            if out:
                self.writer.write(out)
                await self.writer.drain()
            # Ack only once the local socket has taken the bytes — that is what lets a
            # slow local service push back on the server.
            self.agent.send(p.stream_ack(self.id, consumed))

    def _buffer_head(self, chunk: bytes) -> bytes:
        """Holds bytes back until the request head is complete, then rewrites Host."""
        self._head_buf += chunk
        if b"\r\n\r\n" in self._head_buf or len(self._head_buf) >= MAX_HEAD_BUFFER:
            out = _rewrite_host_header(self._head_buf, self.spec.target)
            self._head_buf = b""
            self._head_done = True
            return out
        return b""

    # ---- local -> server ----------------------------------------------------

    async def _to_server(self) -> None:
        while True:
            if self.send_credit <= 0:
                self.credit.clear()
                await self.credit.wait()
            try:
                chunk = await self.reader.read(LOCAL_READ_CHUNK)
            except (OSError, ConnectionResetError):
                self.agent.send(
                    p.stream_json(p.STREAM_RESET, self.id, {"code": "local_error"})
                )
                return
            if not chunk:
                self.agent.send(p.stream_only(p.STREAM_EOF, self.id))
                return
            self.send_credit -= len(chunk)
            self.agent.send(p.stream_data(self.id, chunk))

    def add_credit(self, granted: int) -> None:
        self.send_credit += granted
        if self.send_credit > 0:
            self.credit.set()

    # ---- teardown -----------------------------------------------------------

    def reset(self) -> None:
        self.finish(notify=False)

    def finish(self, notify: bool = False) -> None:
        if self.finished:
            return
        self.finished = True
        for task in self.tasks:
            task.cancel()
        if self.writer is not None:
            try:
                self.writer.close()
            except OSError:
                pass
        if notify:
            self.agent.send(p.stream_json(p.STREAM_RESET, self.id, {"code": "closed"}))
        self.agent.streams.pop(self.id, None)


class Agent:
    def __init__(self, cfg: AgentConfig):
        self.cfg = cfg
        self.streams: dict = {}
        self.tunnels: dict = {}  # tunnelId -> TunnelSpec
        self.window = 256 * 1024
        self._out: asyncio.Queue = asyncio.Queue()
        self._ws = None
        self._pending: dict = {}  # reqId -> TunnelSpec

    # ---- outbound serialisation --------------------------------------------

    def send(self, frame: bytes) -> None:
        """Queues a frame. All sends funnel through one task so frames never interleave."""
        self._out.put_nowait(frame)

    async def _sender(self, ws) -> None:
        try:
            while True:
                frame = await self._out.get()
                await ws.send(frame)
        except (ConnectionClosed, OSError):
            pass  # the read loop notices the same close and drives the reconnect

    # ---- connection lifecycle ----------------------------------------------

    async def run_forever(self) -> None:
        delay = RECONNECT_MIN
        loop = asyncio.get_running_loop()
        while True:
            started = loop.time()
            try:
                await self._session()
                log.warning("server closed the connection")
                health("session ended", reason="server closed the connection",
                       uptimeSec=round(loop.time() - started))
            except AuthError:
                raise
            except (OSError, ConnectionClosed, asyncio.TimeoutError) as exc:
                log.warning("disconnected: %s", exc)
                health("session ended", reason=repr(str(exc)),
                       uptimeSec=round(loop.time() - started))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("session ended unexpectedly: %r", exc)
                health("session ended", reason=repr(exc),
                       uptimeSec=round(loop.time() - started))

            # Only a session that actually held up earns a reset to the minimum delay.
            if loop.time() - started >= STABLE_SESSION:
                delay = RECONNECT_MIN

            # Jitter stops a fleet of devices reconnecting on the same tick after a
            # server restart.
            wait = delay * random.uniform(0.7, 1.3)
            log.info("reconnecting in %.0fs", wait)
            await asyncio.sleep(wait)
            delay = min(delay * 2, RECONNECT_MAX)

    async def _session(self) -> None:
        ssl_ctx = None
        if self.cfg.server.startswith("wss://") and self.cfg.insecure:
            ssl_ctx = ssl.create_default_context()
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

        log.info("connecting to %s", self.cfg.server)
        health("connecting", server=self.cfg.server)
        # websockets drives the keepalive itself: it pings every ping_interval and
        # drops the connection if a pong does not come back within ping_timeout.
        # Either may be None, which turns off that half of it.
        kwargs = dict(
            max_size=None,
            ping_interval=self.cfg.ping_interval,
            ping_timeout=self.cfg.ping_timeout,
            open_timeout=15,
        )
        if ssl_ctx is not None:
            kwargs["ssl"] = ssl_ctx

        async with websockets.connect(self.cfg.server, **kwargs) as ws:
            self._ws = ws
            self.streams.clear()
            self.tunnels.clear()
            self._pending.clear()
            while not self._out.empty():  # drop frames queued for the dead session
                self._out.get_nowait()

            await ws.send(
                p.control(
                    p.HELLO,
                    {
                        "version": p.PROTOCOL_VERSION,
                        "token": self.cfg.token,
                        "name": self.cfg.name,
                        "client": CLIENT_ID,
                        # Informational, so a headless box can be found on its
                        # own network from the server's logs. See docs/PROTOCOL.md.
                        "lanIp": _primary_lan_ip(),
                    },
                )
            )
            raw = await asyncio.wait_for(ws.recv(), HANDSHAKE_TIMEOUT)
            frame_type, _, body = p.decode(_as_bytes(raw))
            if frame_type == p.ERROR:
                code = body.get("code", "error")
                message = body.get("message", "")
                if code in ("unauthorized", "bad_version"):
                    raise AuthError("%s: %s" % (code, message))
                raise RuntimeError("handshake failed: %s %s" % (code, message))
            if frame_type != p.HELLO_OK:
                raise RuntimeError("expected HELLO_OK, got %s" % p.NAMES.get(frame_type, frame_type))

            self.window = int(body.get("streamWindow", self.window))
            log.info(
                "connected as %s (agent %s, window %dKiB)",
                self.cfg.name,
                body.get("agentId", "?"),
                self.window // 1024,
            )

            health("session up", server=self.cfg.server,
                   agentId=body.get("agentId"), lanIp=_primary_lan_ip(),
                   pingSec=self.cfg.ping_interval, pingTimeoutSec=self.cfg.ping_timeout)

            sender = asyncio.create_task(self._sender(ws))
            try:
                for i, spec in enumerate(self.cfg.tunnels):
                    req_id = str(i)
                    self._pending[req_id] = spec
                    self.send(p.control(p.OPEN_TUNNEL, _open_body(req_id, spec)))
                await self._read_loop(ws)
            finally:
                sender.cancel()
                for stream in list(self.streams.values()):
                    stream.finish(notify=False)
                self.streams.clear()
                self._ws = None

    async def _read_loop(self, ws) -> None:
        async for raw in ws:
            try:
                frame_type, stream_id, body = p.decode(_as_bytes(raw))
            except p.ProtocolError as exc:
                log.warning("bad frame from server: %s", exc)
                continue
            if stream_id is None:
                self._on_control(frame_type, body)
            else:
                self._on_stream(frame_type, stream_id, body)

    # ---- frame handlers ----------------------------------------------------

    def _on_control(self, frame_type: int, body: dict) -> None:
        if frame_type == p.TUNNEL_OK:
            req_id = str(body.get("reqId", ""))
            spec = self._pending.pop(req_id, None)
            tunnel_id = str(body.get("tunnelId", ""))
            if spec is not None and tunnel_id:
                self.tunnels[tunnel_id] = spec
            where = body.get("publicUrl") or "%s:%s" % (
                body.get("publicHost", "?"),
                body.get("publicPort", "?"),
            )
            log.info("%-10s %s  ->  %s", spec.name if spec else "?", where, spec.target if spec else "?")
        elif frame_type == p.ERROR:
            req_id = str(body.get("reqId", ""))
            spec = self._pending.pop(req_id, None)
            label = spec.name if spec else "server"
            log.error("%s: %s (%s)", label, body.get("message", ""), body.get("code", "error"))
        else:
            log.debug("ignoring control frame %s", p.NAMES.get(frame_type, frame_type))

    def _on_stream(self, frame_type: int, stream_id: int, payload: bytes) -> None:
        if frame_type == p.STREAM_OPEN:
            meta = p.payload_json(payload)
            spec = self.tunnels.get(str(meta.get("tunnelId", "")))
            if spec is None:
                self.send(
                    p.stream_json(
                        p.STREAM_RESET, stream_id, {"code": "unknown_tunnel"}
                    )
                )
                return
            stream = Stream(self, stream_id, spec, self.window)
            self.streams[stream_id] = stream
            asyncio.create_task(stream.run())
            return

        stream = self.streams.get(stream_id)
        if stream is None:
            # The server may still be draining a stream we already tore down.
            if frame_type != p.STREAM_RESET:
                self.send(p.stream_json(p.STREAM_RESET, stream_id, {"code": "unknown_stream"}))
            return

        if frame_type == p.STREAM_DATA:
            stream.feed(payload)
        elif frame_type == p.STREAM_EOF:
            stream.feed_eof()
        elif frame_type == p.STREAM_ACK:
            if len(payload) >= 4:
                stream.add_credit(int.from_bytes(payload[:4], "big"))
        elif frame_type == p.STREAM_RESET:
            stream.reset()
        else:
            log.debug("ignoring stream frame %s", p.NAMES.get(frame_type, frame_type))


def _open_body(req_id: str, spec: TunnelSpec) -> dict:
    body = {
        "reqId": req_id,
        "kind": spec.kind,
        "target": {"host": spec.target_host, "port": spec.target_port},
    }
    if spec.kind == "http":
        body["subdomain"] = spec.subdomain
    elif spec.remote_port:
        body["remotePort"] = spec.remote_port
    return body


def _as_bytes(raw) -> bytes:
    return raw if isinstance(raw, bytes) else raw.encode("utf-8")
