# Client setup

There are **two agents, and they're interchangeable** — same protocol, same flags, same
config file format. Pick whichever matches the machine you're on:

| Agent | Directory | Runtime | Use it when |
|-------|-----------|---------|-------------|
| **Python** | `client/` | Python 3.9+ | Raspberry Pi, a server that already has Python, or you want the smaller install |
| **Node** | `client-node/` | Node 20+ | You already run Node, or you want to embed the agent in a JS program |

Both make one **outbound** connection to your server on port 443 — nothing to forward on
your router, nothing to open on your firewall.

You need two things from the server before starting:

- the control URL, `wss://tunnel.example.com/control`
- this device's token from `~/up-tunnel/server/tokens.json`

---

## Install: Python agent

### With pipenv (recommended)

The repo ships a `Pipfile` and a committed `Pipfile.lock`, so you get the exact dependency
set that was tested:

```bash
cd client
pipenv install --dev        # --dev also brings PyYAML, for up.yaml configs
pipenv run uptunnel --version
```

Useful `pipenv` entry points:

```bash
# Set your environment variables in a .env file first
pipenv run uptunnel http 3000 --subdomain mac   # run the agent
pipenv run test                                 # protocol conformance tests
pipenv shell                                    # drop into the venv
```

`pipenv install` without `--dev` skips PyYAML — fine if you use a `.json` config.

> The `Pipfile` pins `python_version = "3.11"`. If that version isn't on the machine, either
> install it (`brew install python@3.11`, `apt install python3.11`) or run
> `pipenv --python 3.9 install` to use whatever you have — the code supports 3.9+.

### With plain venv

If you'd rather not add pipenv to a device:

```bash
# Raspberry Pi / Debian:
sudo apt install -y python3-venv

python3 -m venv ~/.uptunnel-venv
~/.uptunnel-venv/bin/pip install /path/to/up-tunnel/client
~/.uptunnel-venv/bin/uptunnel --version
```

### Windows (PowerShell)

```powershell
cd client
pipenv install --dev
pipenv run uptunnel --version
```

---

## Install: Node agent

The repo pins the Node version in `.nvmrc`, so:

```bash
cd client-node
nvm use            # reads .nvmrc — installs it first with `nvm install` if needed
npm install
npm run build
node dist/cli.js --version
```

Install it on your PATH as `uptunnel`:

```bash
npm link           # or: npm install -g .
uptunnel --version
```

Run it straight from TypeScript while developing, no build step:

```bash
# Set your environment variables in a .env file first
npm run dev -- http 3000 --subdomain mac
```

`npm install` pulls `yaml` as an optional dependency for `up.yaml` configs. A `.json`
config needs only `ws`.

> If you install both agents globally they both provide an `uptunnel` command and PATH
> order decides which one wins. Normally you want one per machine.

---

## Your first tunnel

Identical for both agents:

```bash
export UPTUNNEL_SERVER=wss://tunnel.example.com/control
export UPTUNNEL_TOKEN=the-secret-for-this-device

python3 -m http.server 3000 &          # something to expose

uptunnel http 3000 --subdomain test
```

```
14:02:11 INFO  connecting to wss://tunnel.example.com/control
14:02:11 INFO  connected as my-laptop (agent ag_9e807a16d29b, window 256KiB)
14:02:11 INFO  test       https://test.tun.example.com  ->  127.0.0.1:3000
```

Open that URL from your phone. Ctrl-C stops the agent and releases the subdomain.

---

## Command reference

```bash
uptunnel http <port|host:port> --subdomain <name> [--rewrite-host]
uptunnel tcp  <port|host:port> [--remote-port <n>]
uptunnel [--config up.yaml]              # run everything in the config file
```

| Flag | Meaning |
|------|---------|
| `--server URL` | control URL; or `UPTUNNEL_SERVER` |
| `--token SECRET` | this device's token; or `UPTUNNEL_TOKEN` |
| `--name LABEL` | label in server logs; defaults to the hostname |
| `--subdomain NAME` | required for `http`; becomes `NAME.tun.example.com` |
| `--remote-port N` | preferred public port for `tcp`; server picks one if omitted |
| `--rewrite-host` | rewrite `Host` to the local target — needed by Vite, webpack, Angular |
| `--insecure` | skip TLS verification (self-signed certs only) |
| `-v` | debug logging |
| `-vv` | *(Python only)* plus raw WebSocket frames |

Targets accept a bare port (`3000`), a host and port (`192.168.1.50:80`), or IPv6
(`[::1]:3000`). A bare port means `127.0.0.1`, so pointing at another machine on your LAN
just needs its address: `uptunnel http 192.168.1.50:80 --subdomain printer`.

---

## Config file

For anything you run more than once. `up.yaml` (or `up.json`) in the working directory is
picked up automatically; otherwise pass `--config`. Both agents read the same file.

```yaml
server: wss://tunnel.example.com/control
token: the-secret-for-this-device
name: macbook          # label in server logs; defaults to the hostname

tunnels:
  - name: web
    kind: http
    subdomain: mac      # -> https://mac.tun.example.com
    target: 3000
    rewrite_host: true  # dev servers reject an unfamiliar Host header

  - name: ssh
    kind: tcp
    remote_port: 20022  # omit to let the server pick
    target: 22

  - name: mqtt
    kind: tcp
    remote_port: 20083
    target: 127.0.0.1:1883
```

Then just:

```bash
uptunnel
```

All tunnels come up on one WebSocket. The same file as JSON needs no YAML library at all:

```json
{
  "server": "wss://tunnel.example.com/control",
  "token": "the-secret-for-this-device",
  "tunnels": [
    { "name": "web", "kind": "http", "subdomain": "mac", "target": 3000 }
  ]
}
```

> `up.yaml` and `up.json` are gitignored — they hold your token. `chmod 600 up.yaml`.

---

## Connection lifetime and recovery

**How long does one WebSocket last?** Indefinitely. Nothing in the design caps it, and the
30-second heartbeat means the connection never sits idle long enough for anything in the
path to decide it's dead. The shipped nginx config sets `proxy_read_timeout 7d`, which the
heartbeat keeps you from ever reaching.

**What does break connections in practice:**

| Cause | Detected in | Recovery |
|-------|-------------|----------|
| Home/carrier NAT dropping an idle mapping | prevented by the 30s heartbeat | n/a |
| Laptop sleep, wifi or LTE handover | up to ~40s (client heartbeat) | automatic reconnect |
| Server restart or redeploy | immediately (clean close) | automatic reconnect |
| Link black-holed without a TCP reset | up to ~40s (client heartbeat) | automatic reconnect |

**Detection.** Each agent pings the server every `UPTUNNEL_PING_INTERVAL` (20s default) and
reconnects if a ping goes unanswered for `UPTUNNEL_PING_TIMEOUT` (20s default). That is the
check that matters for recovery: it catches a black-holed link, where TCP itself would sit
there for minutes, and it is the agent — not the server — that has to act to restore the
tunnel.

The server pings in the other direction every `HEARTBEAT_MS` (30s default) and drops an
agent after `HEARTBEAT_MISSES` (**10** by default, so ~5 minutes) consecutive ticks with
nothing back from it — anything inbound, including the agent's own pings, counts as alive.
It is deliberately slower to give up than the agent: dropping the session frees the
subdomain, which fixes nothing on a link that is merely slow, and the agent is already
reconnecting on its own if the link is genuinely dead.

Both directions matter. A one-sided check is how a device ends up believing it is connected
while the server has already freed its subdomain and every request returns 502.

**Tuning the ping.** Both variables are read by both agents and take **seconds**; `0`
disables that half (no ping at all, or a ping whose answer is never waited on). Raise the
interval on a metered LTE link, lower it behind a NAT that reaps idle mappings aggressively.
Keep the interval below any proxy read timeout in the path, or the connection will be culled
between pings.

| Variable | Default | Meaning |
|----------|---------|---------|
| `UPTUNNEL_PING_INTERVAL` | 20 | seconds between pings to the server; 0 disables |
| `UPTUNNEL_PING_TIMEOUT` | 20 | seconds a ping may go unanswered before reconnecting; 0 waits forever |

**Health log.** On by default: the agent records the connection lifecycle to `health.log`
in the directory it runs from — connect, session up, heartbeat round trips, missed
heartbeats, and how each session ended. It is capped at `UPTUNNEL_HEALTH_LOG_MAX_LINES`
(default **1000**) and trims to the newest 80%, so it is safe to leave on forever. Point
`UPTUNNEL_HEALTH_LOG` somewhere else — an absolute path if the service runs from a
directory you'd rather not write to — or set it to the empty string to turn it off.

| Variable | Default | Meaning |
|----------|---------|---------|
| `UPTUNNEL_HEALTH_LOG` | `health.log` (working directory) | file to append health events to; empty disables |
| `UPTUNNEL_HEALTH_LOG_MAX_LINES` | 1000 | ceiling; a trim keeps the newest 80% |

The Node agent logs a line per ping (`server pong rttMs=…`), which is what gives you a
round-trip history. The Python agent does not: its keepalive lives inside the `websockets`
library, which never hands the pings back to it, so its log has session boundaries only.

Both agents (Python and Node) use the same variables and the same line format, and the
server keeps a matching log of its own (`HEALTH_LOG_FILE`, see
[SERVER-SETUP.md](SERVER-SETUP.md)). When a device goes unreachable, the question is always
which end gave up first — comparing the two files is how you answer it.

```
2026-08-15T03:41:54.044Z session up server=wss://tunnel.example.com/control lanIp=192.168.86.31
2026-08-15T03:42:14.103Z server pong rttMs=103
2026-08-15T03:45:13.981Z session ended reason='server closed the connection' uptimeSec=200
```

**Reporting the LAN address.** Each agent includes the address it believes it has on its own
network in its `HELLO`. It shows up in the server's `health.log` and in
`curl -s localhost:8082/status | jq '.agents[].lanIp'`. This is for headless machines: when
a box is reachable only through the tunnel, nothing else tells you what address DHCP gave
it. It is informational only — the server never routes or authenticates on it.

**Reconnect.** Exponential backoff from 1s to a 60s ceiling, with ±30% jitter so a fleet of
devices doesn't stampede the server after a restart. On reconnect the agent re-registers
every tunnel, so URLs and ports come back unchanged.

```
02:00:17 WARNING disconnected: [Errno 61] Connect call failed ('tunnel.example.com', 443)
02:00:17 INFO  reconnecting in 2s
02:00:19 INFO  connecting to wss://tunnel.example.com/control
02:00:19 WARNING disconnected: [Errno 61] Connect call failed
02:00:19 INFO  reconnecting in 4s
02:00:23 INFO  connected as macbook (agent ag_e6c3e726caca, window 256KiB)
02:00:23 INFO  web        https://mac.tun.example.com  ->  127.0.0.1:3000
```

The backoff only resets to 1s after a session that stayed up for at least 30 seconds. That
matters: without it, a server that accepts connections and immediately drops them would get
retried once a second forever, because every attempt technically succeeded.

**What does not survive a reconnect:** connections that were in flight. A download in
progress fails and a live SSH session drops — there's no session resumption. New connections
work the moment the tunnel re-registers, typically 1–2 seconds later.

**A bad token is the one thing the agent won't retry**, since retrying can't help:

```
ERROR authentication failed — unauthorized: token not recognised
```

> **If you put a load balancer in front of the server**, its idle timeout now applies (ALB
> defaults to 60s, NLB to 350s). Raise it above `HEARTBEAT_MS` or connections will be culled
> mid-tunnel. Going direct to EC2, as this guide does, has no such limit.

---

## Run it as a service

### Linux / Raspberry Pi (systemd)

Python agent:

```bash
sudo tee /etc/systemd/system/uptunnel-agent.service >/dev/null <<'EOF'
[Unit]
Description=uptunnel agent
After=network-online.target
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi
ExecStart=/home/pi/.uptunnel-venv/bin/uptunnel --config /home/pi/up.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now uptunnel-agent
journalctl -u uptunnel-agent -f
```

Node agent — same unit with a different `ExecStart`:

```ini
ExecStart=/usr/bin/node /home/pi/up-tunnel/client-node/dist/cli.js --config /home/pi/up.yaml
```

Use an absolute `node` path rather than an nvm shim: nvm lives in your shell profile, which
systemd does not load. `command -v node` inside `nvm use` tells you the real path.

Replace `pi` with your username on non-Pi systems.

### macOS (launchd)

```bash
mkdir -p ~/Library/LaunchAgents
tee ~/Library/LaunchAgents/com.uptunnel.agent.plist >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.uptunnel.agent</string>
  <key>ProgramArguments</key><array>
    <string>$HOME/.uptunnel-venv/bin/uptunnel</string>
    <string>--config</string><string>$HOME/up.yaml</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/uptunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/uptunnel.log</string>
</dict></plist>
EOF

launchctl load ~/Library/LaunchAgents/com.uptunnel.agent.plist
tail -f ~/Library/Logs/uptunnel.log
```

### Windows (Task Scheduler)

```powershell
$action  = New-ScheduledTaskAction -Execute "$HOME\.uptunnel-venv\Scripts\uptunnel.exe" `
                                   -Argument "--config $HOME\up.yaml"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "uptunnel" -Action $action -Trigger $trigger
```

---

## Embedding the Node agent in your own program

The Node client is a library as well as a CLI, which is the one thing the Python agent
doesn't offer:

```ts
import { Agent } from "uptunnel-client";

const agent = new Agent({
  server: "wss://tunnel.example.com/control",
  token: process.env.UPTUNNEL_TOKEN!,
  name: "my-service",
  insecure: false,
  tunnels: [
    { name: "web", kind: "http", subdomain: "app", targetHost: "127.0.0.1", targetPort: 3000 },
  ],
});

await agent.runForever();   // resolves only on a fatal auth error
// agent.stop() to shut down cleanly
```

Useful for exposing an app's own dev server from inside the app, without a second process.

---

## Microcontrollers (ESP32, Pi Pico W)

**Neither client runs on these.** MicroPython has no `websockets` library and too little RAM
for it, and Node obviously doesn't run there at all. An MCU agent needs a hand-rolled
WebSocket framer written against [PROTOCOL.md](PROTOCOL.md) — which is why the protocol is
small and binary. `client/uptunnel/protocol.py` is already written in
MicroPython-compatible style and can be lifted as-is; the rest cannot.

The shared byte vectors in `tests/protocol-vectors.json` are the fastest way to check a new
implementation frames things correctly before you try it against the server.
