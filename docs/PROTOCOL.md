# uptunnel wire protocol v1

The agent (local device) opens **one** WebSocket to the server and multiplexes every
tunnelled connection over it. All application data is carried as raw bytes — the server
never interprets the payload beyond peeking the HTTP `Host` header to pick a route.

```
internet ──TLS──> nginx ──plain──> tunnel server ──WebSocket──> agent ──> 127.0.0.1:port
```

## Transport

- WebSocket over TLS: `wss://tunnel.<domain>/control`
- All frames are **binary** WebSocket messages. Text messages are a protocol error.
- Liveness uses WebSocket ping/pong. The server pings every `heartbeatMs`; an agent that
  misses two consecutive pongs is disconnected.
- WebSocket already delimits messages, so frames carry no length prefix.

## Frame layout

```
byte 0        type (u8)

type < 0x20   control frame:  bytes 1..   = UTF-8 JSON object
type >= 0x20  stream frame:   bytes 1..5  = streamId (u32, big-endian)
                              bytes 5..   = type-specific payload
```

| Type   | Name           | Direction     | Payload |
|--------|----------------|---------------|---------|
| `0x01` | `HELLO`        | agent→server  | JSON |
| `0x02` | `HELLO_OK`     | server→agent  | JSON |
| `0x03` | `ERROR`        | both          | JSON |
| `0x10` | `OPEN_TUNNEL`  | agent→server  | JSON |
| `0x11` | `TUNNEL_OK`    | server→agent  | JSON |
| `0x12` | `CLOSE_TUNNEL` | agent→server  | JSON |
| `0x20` | `STREAM_OPEN`  | server→agent  | streamId + JSON |
| `0x21` | `STREAM_DATA`  | both          | streamId + raw bytes |
| `0x22` | `STREAM_EOF`   | both          | streamId |
| `0x23` | `STREAM_ACK`   | both          | streamId + u32 bytes consumed |
| `0x24` | `STREAM_RESET` | both          | streamId + JSON |

Streams are **always** initiated by the server, because every tunnelled connection
originates on the public internet. Agents never send `STREAM_OPEN`.

## Handshake

Agent, immediately after the socket opens:

```json
0x01 {"version": 1, "token": "<secret>", "name": "laptop", "client": "uptunnel-py/0.1.0"}
```

Server replies:

```json
0x02 {"agentId": "ag_7f3c...", "heartbeatMs": 30000, "streamWindow": 262144,
      "httpDomain": "tun.example.com", "serverVersion": "0.1.0"}
```

On failure the server sends `ERROR` and closes with code `4001` (`unauthorized`),
`4002` (`bad_version`), or `4000` (`bad_request`).

`streamWindow` is the initial per-stream, per-direction credit in bytes. An agent MUST
honour whatever the server advertises.

## Registering tunnels

The agent asks for each tunnel it wants. `reqId` is any agent-chosen string, echoed back.

HTTP tunnel — server routes by subdomain:

```json
0x10 {"reqId": "1", "kind": "http", "subdomain": "laptop", "target": {"host": "127.0.0.1", "port": 3000}}
```

TCP tunnel — server allocates a public port (`remotePort` is a preference, omit for any):

```json
0x10 {"reqId": "2", "kind": "tcp", "remotePort": 20022, "target": {"host": "127.0.0.1", "port": 22}}
```

Success:

```json
0x11 {"reqId": "1", "tunnelId": "tn_a91b", "kind": "http",
      "subdomain": "laptop", "publicUrl": "https://laptop.tun.example.com"}
0x11 {"reqId": "2", "tunnelId": "tn_c204", "kind": "tcp",
      "publicPort": 20022, "publicHost": "tunnel.example.com"}
```

Failure carries the `reqId` so the agent can match it:

```json
0x03 {"reqId": "1", "code": "subdomain_taken", "message": "laptop is in use"}
```

Error codes: `unauthorized`, `bad_version`, `bad_request`, `subdomain_taken`,
`subdomain_forbidden`, `port_taken`, `port_forbidden`, `no_ports_available`,
`too_many_tunnels`.

`target` is informational for the server — the agent is what actually dials it — but the
server stores it so `/status` can show what a tunnel points at.

To retire a tunnel without disconnecting: `0x12 {"tunnelId": "tn_a91b"}`.
All of an agent's tunnels are released when its WebSocket closes.

## Stream lifecycle

A public connection arrives. The server allocates an odd/even-agnostic `streamId`
(monotonic u32 per session, never reused within a session) and sends:

```
0x20 <streamId> {"tunnelId": "tn_a91b", "remoteAddr": "203.0.113.9:51234"}
```

The agent connects to its local target for that tunnel, then:

- **On success** it starts relaying. There is no explicit "open ok" frame — the first
  `STREAM_DATA`, `STREAM_EOF`, or simply the absence of a reset is success. Frames the
  server has already sent are buffered by the agent until the local socket is up.
- **On failure** it replies `0x24 <streamId> {"code": "dial_failed", "message": "..."}`
  and the server serves a 502 (HTTP) or drops the connection (TCP).

Both sides then exchange `STREAM_DATA`. `STREAM_EOF` closes one direction only — the
sender promises no further `STREAM_DATA` for that stream, and the receiver half-closes
its socket (`shutdown(SHUT_WR)`). A stream is fully done once EOF has passed in both
directions, or after a `STREAM_RESET` from either side.

`STREAM_RESET` aborts both directions immediately. It is also the correct response to a
frame naming an unknown `streamId`.

## Flow control

Without flow control, one slow local service would let the server buffer the whole
internet's worth of data in RAM. Each stream therefore has a credit window **per
direction**, initialised to `streamWindow` bytes.

- A sender decrements its credit by the payload length of every `STREAM_DATA` it sends.
  At zero credit it MUST stop sending and apply backpressure to its own source socket.
- A receiver sends `STREAM_ACK <streamId> <n>` once it has actually handed `n` bytes to
  the destination socket (i.e. after the write drains — *not* on arrival). Credit is
  additive: the sender adds `n` back and may resume.
- Acks may be coalesced. Do not delay them past a drained socket buffer, or the peer
  stalls.

Credits bound per-stream memory. Implementations should additionally cap total buffering
on the WebSocket itself and pause every stream when that cap is hit.

## Connection lifetime

There is no limit. A session lasts until one side closes it or the path breaks. The
heartbeat exists to keep NAT mappings and proxy read timeouts from expiring an idle
connection, and to detect a link that has been black-holed without a TCP reset.

An agent SHOULD also ping in the other direction on its own schedule rather than relying
only on the server's pings — that is what notices a dead uplink promptly instead of waiting
on TCP timeouts. On reconnect an agent MUST re-send `HELLO` and re-register every tunnel;
nothing about a previous session is remembered by the server. Streams are not resumable, so
connections that were in flight are simply gone.

## Conformance vectors

`tests/protocol-vectors.json` holds golden byte vectors — exact frame encodings, decoder
inputs including malformed ones, and `Host`-rewrite cases. Three independent implementations
of this spec exist (the Node server, the Node client, the Python client), and both clients
assert against these vectors so the wire format cannot drift in one of them unnoticed.

If you write a fourth implementation, check it against those vectors before pointing it at a
real server. Encoding bugs are much easier to see in a hex diff than in a hung tunnel.

## Versioning

`HELLO.version` is an integer. The server rejects versions it does not implement with
`bad_version`. Unknown frame types MUST be ignored rather than treated as fatal, so
future additive types don't break old peers.
