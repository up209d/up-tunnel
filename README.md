# up-tunnel

Your own ngrok. A small server on your EC2 box gives any local device — laptop, Raspberry
Pi, whatever — a public HTTPS URL or a public TCP port, without touching your home router.

```
                          your EC2 box
  ┌──────────┐      ┌──────────────────────────────┐         ┌─────────────┐
  │ internet │─443─▶│ nginx ──▶ uptunnel server     │◀── wss ─│ your device │
  │  visitor │      │           :8080 http          │  :443   │   (agent)   │
  └──────────┘      │           :20000-20099 tcp ◀──┼──443────│             │
                    └──────────────────────────────┘         └──────┬──────┘
                                                                    │
                                                          127.0.0.1:3000 / :22
```

```bash
uptunnel http 3000 --subdomain mac      # -> https://mac.tun.example.com
uptunnel tcp 22 --remote-port 20022     # -> ssh -p 20022 you@tunnel.example.com
```

## Documentation

| Guide | What's in it |
|-------|--------------|
| **[SERVER-SETUP.md](docs/SERVER-SETUP.md)** | Full remote install: DNS, security group, Node, systemd, nginx, wildcard TLS |
| **[CLIENT-SETUP.md](docs/CLIENT-SETUP.md)** | Both agents, per-platform, config file, connection lifetime, run-as-a-service |
| **[USAGE.md](docs/USAGE.md)** | Recipes: web apps, webhooks, SSH, MQTT, LAN access, monitoring |
| **[TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** | Every error code and what to do about it |
| **[PROTOCOL.md](docs/PROTOCOL.md)** | The wire protocol, for writing an agent in another language |

There's also a single-page HTML version of the setup guide at `docs/index.html` (served as the GitHub Pages site).

## Layout

| Path | What it is | Runtime |
|------|-----------|---------|
| `server/` | The tunnel server. Runs on your EC2 instance behind nginx. | Node 20+, one dependency (`ws`) |
| `client/` | **Python** agent. | Python 3.9+, one dependency (`websockets`) |
| `client-node/` | **Node** agent. Same protocol and flags; also usable as a library. | Node 20+, one dependency (`ws`) |
| `deploy/` | nginx site config and a hardened systemd unit. | |
| `tests/` | Shared protocol byte vectors, asserted by both clients. | |

**The two clients are interchangeable** — same wire protocol, same CLI flags, same config
file. Install whichever suits the machine. Node versions are pinned in `.nvmrc`; the Python
client ships a `Pipfile` and a committed `Pipfile.lock`.

## How it works

Each device holds **one** outbound WebSocket to the server (`wss://tunnel.<domain>/control`)
and every tunnelled connection is multiplexed over it. Outbound-only means no port
forwarding; port 443 means it works from behind restrictive networks.

The server does **not** parse HTTP beyond peeking the `Host` header to pick a route — after
that it pipes raw bytes. That's why WebSockets, SSE, chunked bodies and plain SSH all work
through the same code path with no special handling.

Each stream is flow-controlled with a credit window in both directions, so one slow device
can't make the server buffer the internet in RAM.

Connections last indefinitely: a 30-second heartbeat keeps NAT mappings and proxy timeouts
from ever expiring them, and each agent independently detects a dead link within ~40s and
reconnects with jittered exponential backoff. See
[Connection lifetime and recovery](docs/CLIENT-SETUP.md#connection-lifetime-and-recovery).

## What's verified working

Tested end to end with **both** clients: HTTP GET/POST; 3 MB bodies byte-for-byte intact;
20 concurrent multiplexed transfers; raw TCP with correct half-close; `--rewrite-host`
confirmed against a service that echoes the `Host` it received; tunnels released on
disconnect; reconnect with escalating jittered backoff, re-registering every tunnel.

Additionally on the Python client: a 150 MB body intact, SSE arriving incrementally rather
than buffered, and WebSocket upgrades including 512 KiB frames.

**Flow control**, measured: a deliberately stalled 150 MB download grew the server's RSS by
~15 MB, not 150 MB.

**SSH** — through both clients: remote command execution, `scp` of a 20 MB file
byte-identical, PTY allocation (`ssh -tt` gets a real tty). Also verified via the Python
client: `sftp` and nested `ssh -L` forwarding back out through the tunnel.

**Protocol conformance:** `tests/protocol-vectors.json` holds golden byte vectors that both
clients assert against, so the three independent implementations of the wire format can't
drift silently.

```bash
cd client-node && npm test                       # 7 tests
cd client && pipenv run test                     # 8 tests
```

## Local development

Three terminals, no TLS, no nginx:

```bash
# 1 — the server
cd server && nvm use && npm install && cp .env.example .env
# in .env set: HTTP_DOMAIN=tun.localhost, PUBLIC_SCHEME=http,
#              AUTH_TOKENS=dev:local-dev-token-0123456789abcdef
npm run dev

# 2 — something to expose
python3 -m http.server 3000

# 3 — an agent (either one)
cd client && pipenv install --dev && pipenv run uptunnel \
  --server ws://127.0.0.1:8081/control \
  --token local-dev-token-0123456789abcdef \
  http 3000 --subdomain demo

# ...or the Node one
cd client-node && nvm use && npm install && npm run dev -- \
  --server ws://127.0.0.1:8081/control \
  --token local-dev-token-0123456789abcdef \
  http 3000 --subdomain demo
```

There's no wildcard DNS locally, so fake the Host header:

```bash
curl -H "Host: demo.tun.localhost" http://127.0.0.1:8080/
```

## Security

- Tokens are bearer secrets in plaintext on both ends. One per device, `chmod 600`, and keep
  the control plane on `wss://` — over `ws://` the token is on the wire.
- A tunnel is a hole through your NAT. Anyone who guesses the subdomain reaches the service,
  so don't tunnel an unauthenticated admin panel and treat the URL as a secret.
- `subdomains` and `ports` grants in `tokens.json` limit what a compromised device can claim.
- The admin API binds `127.0.0.1` with no auth by default. Set `ADMIN_TOKEN` before exposing
  it.

## Known limits

- **No rate limiting or bandwidth caps.** A busy tunnel can saturate the box.
- **Tokens are read once at startup**; adding a device needs a restart.
- **In-flight connections don't survive a reconnect.** There's no session resumption, so a
  download or SSH session in progress dies when the control connection drops. New connections
  work again 1–2 seconds later.
- **One `Host` per upstream connection** is assumed — true for the shipped nginx config, but
  it would break if you enabled upstream keepalive.
- **Microcontrollers aren't supported by either client.** MicroPython has no `websockets`
  library and little RAM; an ESP32/Pico agent needs a hand-rolled WebSocket framer against
  [PROTOCOL.md](docs/PROTOCOL.md). The protocol was kept small and binary for exactly that,
  and `tests/protocol-vectors.json` gives a new implementation something to check itself
  against.
- **No web dashboard** — `/status` returns JSON.
