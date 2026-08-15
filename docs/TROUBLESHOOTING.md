# Troubleshooting

## Where to look first

```bash
# server
sudo systemctl status uptunnel --no-pager
sudo journalctl -u uptunnel -n 50 --no-pager
curl -s localhost:8082/status | jq

# client (either agent)
uptunnel -v                # per-stream detail
uptunnel -vv               # Python agent only: plus raw WebSocket frames
```

Everything here applies to both the Python and Node agents unless noted — they speak the
same protocol and report the same error codes. If you suspect an agent-specific bug, the
quickest triage is to run the *other* agent against the same server and see whether the
symptom follows the client or stays with the server.

Both agents ship conformance tests against shared byte vectors, which rules out a framing
mismatch in seconds:

```bash
cd client-node && npm test
cd client && pipenv run test
```

The server logs every rejection with a reason, so `journalctl -u uptunnel -f` while
reproducing is usually the fastest path.

For anything connection-related, read the **health logs** instead of the general ones.
They are bounded files containing only the connection lifecycle, on both ends:

```bash
tail -f /var/log/uptunnel/health.log        # server (HEALTH_LOG_FILE)
tail -f health.log                          # agent, in the directory it runs from
                                            # (UPTUNNEL_HEALTH_LOG; see CLIENT-SETUP.md)
```

The server's log lasts 10000 lines by default and the agents' 1000, so both survive long
enough to explain a failure you only noticed the next morning.

---

## Agent won't connect

### `authentication failed — unauthorized: token not recognised`

The token isn't in `tokens.json`, or the file was edited without restarting. **Tokens are
read once at startup:**

```bash
sudo systemctl restart uptunnel
```

Check the server saw the attempt:

```bash
sudo journalctl -u uptunnel | grep "rejected unknown token"
```

### `Connect call failed` / connection refused

Work outwards from the server:

```bash
# on the server — is the process up and listening?
curl -s localhost:8082/healthz
sudo ss -tlnp | grep -E '8080|8081|8082'

# through nginx
curl -sI https://tunnel.example.com/healthz

# from the client machine — does DNS resolve and is 443 open?
dig +short tunnel.example.com
nc -zv tunnel.example.com 443
```

If localhost works but nginx doesn't, it's the nginx config. If nginx works locally but not
from outside, it's the security group.

### `bad_version`

Client and server are from different revisions. Update both.

### `server rejected WebSocket connection: HTTP 404`

The URL is wrong. It must include the control path: `wss://tunnel.example.com/control`, not
`wss://tunnel.example.com`.

### Certificate errors

```bash
openssl s_client -connect tunnel.example.com:443 -servername tunnel.example.com </dev/null \
  | openssl x509 -noout -dates -subject
```

The certificate must cover **both** `tunnel.example.com` and `*.tun.example.com`. If it only
covers the base domain, re-run certbot with all three names. `--insecure` on the client
bypasses verification for self-signed certs — never against a real server.

---

## Tunnel connects but the URL doesn't work

### `502 No device is serving …`

The server has no tunnel for that subdomain. Either no agent is connected, or it claimed a
different name:

```bash
curl -s localhost:8082/status | jq '.tunnels[].public'
```

### `404 … is not a tunnel hostname`

The `Host` doesn't end in `HTTP_DOMAIN`, or it has more than one label in front of it. Check
`HTTP_DOMAIN` in `~/up-tunnel/server/.env` matches the domain you're actually browsing,
and that `*.tun.example.com` resolves:

```bash
dig +short anything.tun.example.com
```

`a.b.tun.example.com` will never route — one label only.

### `subdomain_taken`

Another live agent already has it. Find who:

```bash
curl -s localhost:8082/status | jq '.tunnels[] | select(.public | contains("mac"))'
```

### `subdomain_forbidden` / `port_forbidden`

That token's grant in `tokens.json` doesn't cover what you asked for. Either widen
`subdomains` / `ports` for the token, or ask for something inside the grant. `port_forbidden`
also fires when the port is outside the server-wide `TCP_PORT_MIN..MAX`.

### The device says it is connected, but the URL returns 502

The nastiest failure, because both ends look fine from where they are standing. The server
has freed the subdomain; the agent never learned. It happens when the return path is
black-holed — an expired NAT or conntrack entry on a home router — so the server's
`ws.terminate()` never reaches the device as a TCP reset.

Work it from the server's health log first:

```bash
grep -v "agent pong" /var/log/uptunnel/health.log | tail -30
```

| What you see | What it means |
|---|---|
| `agent heartbeat lost, terminating` | the server gave up. Note `uptimeSec` and `misses`; if this repeats, raise `HEARTBEAT_MISSES` or `HEARTBEAT_MS` for that link. |
| `agent disconnected` with a `code` | a clean close — the agent or the network ended it, and the agent should already be reconnecting. |
| `subdomain taken` | a previous session of the **same device** has not been reaped yet. The device is authenticated but nothing routes to it. It clears within a heartbeat or two; if it does not, the old session is a zombie. |
| `tunnel opened` with no matching `tunnel closed` | the subdomain is still registered — the 502 is not a routing problem, look at the agent's local target instead. |
| nothing at all since the last `agent pong` | the server never noticed either. Check that the process is alive and that its own clock is sane. |

Then check whether the agent agrees it is connected. The Pico firmware answers this over
the LAN:

```bash
curl -s http://<device-lan-ip>/api/health | jq .tunnel
```

`connected: true` here while the server has no such agent is the signature of this failure.
`since_pong_ms` climbing past `idle_timeout_ms` means the device is about to drop and
reconnect on its own — wait one cycle before intervening.

**Don't know the device's LAN address?** That is what the agents report in `HELLO`:

```bash
curl -s localhost:8082/status | jq '.agents[] | {name, lanIp, lanPort, remoteAddr, connectedSec}'
grep "agent connected" /var/log/uptunnel/health.log | tail -5
```

### `502` but the agent is connected and the subdomain is registered

The agent can't reach the local service. Confirm the target is actually up **on the machine
running the agent**:

```bash
curl -v http://127.0.0.1:3000/
```

A service bound to `127.0.0.1` is fine — the agent connects from the same machine. A service
bound to a *different* interface needs the explicit address:
`uptunnel http 192.168.1.50:80 --subdomain x`.

---

## Behaviour problems

### Tunnels drop after ~60 seconds

nginx's `proxy_read_timeout` is too low for a long-lived WebSocket. The shipped config sets
`7d` for `/control`. Check yours:

```bash
grep -A2 proxy_read_timeout /etc/nginx/sites-enabled/uptunnel
```

If you put an **ALB or NLB** in front of the server, its own idle timeout now applies too
(ALB defaults to 60s, NLB to 350s) and will cull connections regardless of what nginx says.
Raise it above `HEARTBEAT_MS`, or go direct to EC2 as the setup guide does.

### Tunnels reconnect over and over

Look at the interval between attempts. Escalating delays (1s, 2s, 4s, 9s…) mean the agent
can't reach the server at all — work through *Connect call failed* above. A **steady ~1s**
rhythm instead means the connection is being established and then dropped immediately;
check `journalctl -u uptunnel` for the rejection reason on the server side.

Expected healthy behaviour is documented in
[CLIENT-SETUP.md § Connection lifetime and recovery](CLIENT-SETUP.md#connection-lifetime-and-recovery):
backoff from 1s to a 60s ceiling with ±30% jitter, resetting only after a session that stayed
up at least 30 seconds.

### A download or SSH session died mid-transfer

Check whether the agent reconnected at that moment. In-flight connections do **not** survive
a control-connection drop — there's no session resumption, so anything in progress fails and
new connections work again a second or two later. If reconnects are frequent, the link
between the device and the server is the thing to fix.

### Requests go to the wrong tunnel

Upstream connection pooling is on. The server peeks `Host` once per connection, so a pooled
connection carrying a second request for a different subdomain would be misrouted. Ensure
there is **no** `keepalive` directive in an upstream block for these locations, and that the
`Connection: close` mapping is present:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

### `Invalid Host header`, or a blank page from a dev server

Vite, webpack-dev-server and Angular reject unfamiliar `Host` values. Add `--rewrite-host`
(or `rewrite_host: true`).

### TCP tunnel registers but connections hang

Almost always the security group:

```bash
nc -zv tunnel.example.com 20022                 # from outside
sudo ss -tlnp | grep 20022                      # on the server
```

Also confirm `TCP_BIND_HOST=0.0.0.0` rather than `127.0.0.1` — with the latter the port only
listens on loopback and is unreachable from the internet.

### Slow transfers on a distant link

Throughput per stream is bounded by `STREAM_WINDOW ÷ round-trip time`. At the 256 KiB default
and 100 ms RTT that's roughly 2.5 MB/s. Raise it:

```bash
# ~/up-tunnel/server/.env
STREAM_WINDOW=1048576
sudo systemctl restart uptunnel
```

Costs more memory per stalled stream. Agents pick the new value up on reconnect.

### `agent socket congested, pausing all streams` in the logs

The device's uplink can't keep up with what's being pushed at it. This is the safety valve
working, not a failure — the server refuses to buffer without bound. If it's constant, the
device is genuinely saturated.

### Server memory climbing

Check open streams:

```bash
curl -s localhost:8082/status | jq '[.agents[].openStreams] | add'
```

Memory is bounded by roughly `STREAM_WINDOW × open streams`, plus `WS_MAX_BUFFERED` per
agent. Lower `STREAM_WINDOW` if many streams are open at once.

---

## Reproducing without DNS

To test the server without any DNS or TLS in the way, fake the `Host` header:

```bash
curl -H "Host: demo.tun.example.com" http://127.0.0.1:8080/
```

That goes straight to the HTTP frontend, bypassing nginx entirely — useful for deciding
whether a problem is in nginx or in the tunnel server.

---

## Error code reference

| Code | Meaning |
|------|---------|
| `unauthorized` | token not in `tokens.json` (restart after editing) |
| `bad_version` | client and server protocol versions differ |
| `bad_request` | malformed frame or missing field |
| `subdomain_taken` | another live agent has that subdomain |
| `subdomain_forbidden` | not permitted by this token's `subdomains`, or reserved |
| `port_taken` | another tunnel has that public port |
| `port_forbidden` | outside this token's `ports` or the server range |
| `no_ports_available` | the whole TCP range is in use |
| `too_many_tunnels` | this token hit `maxTunnels` (default 32) |
| `dial_failed` | the agent couldn't reach the local target |

Reserved subdomains: `www`, `api`, `admin`, `tunnel`, `control`, `status`.
