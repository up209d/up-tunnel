# Server setup (Ubuntu 22.04 / 24.04 on AWS EC2)

Everything below runs on your remote box. Budget about 30 minutes, most of it waiting for
DNS to propagate.

Throughout, replace `example.com` with your domain. The layout this guide builds:

| Hostname                | Purpose |
|-------------------------|---------|
| `tunnel.example.com`    | where agents connect, and where public TCP ports live |
| `*.tun.example.com`     | every HTTP tunnel, e.g. `https://mac.tun.example.com` |

---

## Step 0 — DNS and the EC2 security group

### DNS records

Two A records pointing at your instance:

| Type | Name                 | Value          |
|------|----------------------|----------------|
| A    | `tunnel.example.com` | `<elastic IP>` |
| A    | `*.tun.example.com`  | `<elastic IP>` |

The wildcard is the point: once it exists you can invent `whatever.tun.example.com` without
touching DNS again.

Attach an **Elastic IP** to the instance first. A default public IP changes whenever the
instance stops, which silently breaks every record above.

Verify before continuing:

```bash
dig +short tunnel.example.com
dig +short anything.tun.example.com     # must return the same IP
```

### Security group inbound rules

| Port         | Source    | Why |
|--------------|-----------|-----|
| 22           | your IP   | your own admin SSH — don't open this to the world |
| 80           | 0.0.0.0/0 | HTTP→HTTPS redirect, certificate renewal |
| 443          | 0.0.0.0/0 | agent control plane plus every HTTP tunnel |
| 20000–20099  | 0.0.0.0/0 | public TCP tunnels |

Narrow the TCP range to what you'll actually use. If the only TCP tunnel you ever want is
SSH on 20022, open exactly that.

---

## Step 1 — Node.js 22

Ubuntu's packaged `nodejs` is too old. Use NodeSource:

```bash
sudo apt update && sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version        # expect v22.x — anything >= 20 works
```

The repo pins the version in `.nvmrc`, which matters on your *laptop* where you probably
juggle Node versions:

```bash
cd server && nvm use     # add `nvm install` first if you don't have 22 yet
```

On the server, a system-wide NodeSource install is the better choice — nvm lives in a shell
profile, and systemd doesn't load one. If you do insist on nvm there, put the absolute
interpreter path in the unit file rather than relying on `node` being on `PATH`.

---

## Step 2 — Code and directories

Create the necessary directories:

```bash
sudo mkdir -p /var/log/uptunnel
```

Get the repo onto the box — either clone it:

```bash
git clone https://github.com/up209d/up-tunnel ~/up-tunnel
```

…or push it from your laptop:

```bash
rsync -av --exclude node_modules --exclude dist --exclude .git \
      ./ ubuntu@tunnel.example.com:~/up-tunnel/
```

---

## Step 3 — Build

```bash
cd ~/up-tunnel/server
npm ci --omit=dev
npm install --no-save typescript @types/node @types/ws
npx tsc -p tsconfig.json
```

`npm ci --omit=dev` installs the single runtime dependency (`ws`); the next line adds the
compiler without recording it, then `tsc` produces `dist/`.

**Prefer no toolchain on the server?** Run `npm install && npm run build` on your laptop and
copy `server/dist/` up. The server only needs `dist/`, `package.json`, and `node_modules`
containing `ws`.

Sanity check the build:

```bash
ls ~/up-tunnel/server/dist/index.js
```

---

## Step 4 — Agent credentials

One token per device. Generate each with `openssl rand -hex 24`:

```bash
openssl rand -hex 24    # run once per device, keep the output
```

```bash
tee ~/up-tunnel/server/tokens.json >/dev/null <<'EOF'
{
  "tokens": [
    {
      "name": "macbook",
      "token": "PASTE_FIRST_SECRET",
      "subdomains": ["mac", "mac-*"],
      "ports": [20000, 20019]
    },
    {
      "name": "raspberrypi",
      "token": "PASTE_SECOND_SECRET",
      "subdomains": ["pi", "pi-*"],
      "ports": [20020, 20039]
    }
  ]
}
EOF
chmod 600 ~/up-tunnel/server/tokens.json
```

| Field        | Meaning |
|--------------|---------|
| `name`       | label in logs and `/status` |
| `token`      | the shared secret the device presents |
| `subdomains` | patterns this token may claim. `*` matches any label; `pi-*` matches a prefix. Omit to allow anything free. |
| `ports`      | inclusive public TCP port range this token may claim |
| `maxTunnels` | cap on simultaneous tunnels (default 32) |

Per-token grants mean a compromised Pi can't hijack your laptop's subdomain.

> Tokens are read **once at startup**. After editing, `sudo systemctl restart uptunnel`.

---

## Step 5 — Server configuration

```bash
tee ~/up-tunnel/server/.env >/dev/null <<'EOF'
CONTROL_HOST=127.0.0.1
CONTROL_PORT=8081
CONTROL_PATH=/control

HTTP_HOST=127.0.0.1
HTTP_PORT=8080
HTTP_DOMAIN=tun.example.com
PUBLIC_SCHEME=https

TCP_BIND_HOST=0.0.0.0
TCP_PORT_MIN=20000
TCP_PORT_MAX=20099
PUBLIC_TCP_HOST=tunnel.example.com

TOKENS_FILE=tokens.json

ADMIN_HOST=127.0.0.1
ADMIN_PORT=8082

LOG_LEVEL=info
LOG_FORMAT=json

HEALTH_LOG_FILE=/var/log/uptunnel/health.log
HEALTH_LOG_MAX_LINES=10000
HEARTBEAT_MISSES=10
EOF
chmod 600 ~/up-tunnel/server/.env
```

Two details worth understanding:

- `CONTROL_HOST` and `HTTP_HOST` are `127.0.0.1` on purpose — only nginx talks to them, so
  they are never directly reachable from the internet.
- `TCP_BIND_HOST` is `0.0.0.0` because those ports *are* the public entry points; nginx is
  not involved in TCP tunnels at all.

The full list of variables is in `server/.env.example`.

---

## Step 6 — Wildcard TLS certificate

Let's Encrypt issues wildcards **only** over a DNS-01 challenge, so the usual
`certbot --nginx` webroot flow cannot work here.

```bash
sudo apt install -y certbot
sudo certbot certonly --manual --preferred-challenges dns \
  -d tun.example.com -d '*.tun.example.com' -d tunnel.example.com
```

Certbot prints a TXT value. Create `_acme-challenge.tun.example.com` with it at your DNS
provider, wait, verify, then press Enter:

```bash
dig +short TXT _acme-challenge.tun.example.com
```

`--manual` means **renewal is also manual**, every 90 days. For unattended renewal use your
provider's plugin — for Route 53:

```bash
sudo apt install -y python3-certbot-dns-route53
sudo certbot certonly --dns-route53 \
  -d tun.example.com -d '*.tun.example.com' -d tunnel.example.com
sudo systemctl enable --now certbot.timer
```

---

## Step 7 — nginx

```bash
sudo apt install -y nginx
sudo cp ~/up-tunnel/deploy/nginx/uptunnel.conf \
        /etc/nginx/sites-available/uptunnel
sudo sed -i 's/example\.com/YOURDOMAIN.com/g' /etc/nginx/sites-available/uptunnel
sudo ln -sf /etc/nginx/sites-available/uptunnel /etc/nginx/sites-enabled/uptunnel
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Two things in that config are load-bearing:

**`proxy_read_timeout 7d`** — an agent's WebSocket is idle between requests. nginx's default
60s would silently kill every tunnel a minute after it connects.

**The `Connection: close` mapping** —

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

For non-WebSocket requests this sends `Connection: close` upstream, which stops nginx from
pooling upstream connections. That matters because the tunnel server peeks the `Host` header
once per connection and then pipes raw bytes; a pooled connection could carry a second
request for a *different* subdomain and would be misrouted. **Do not add a `keepalive`
directive to an upstream block for these locations.**

---

## Step 8 — Start the service

You can run the server using either **systemd** (recommended for production) or **PM2**.

### Option A: Using systemd (Recommended)

```bash
sudo cp ~/up-tunnel/deploy/systemd/uptunnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uptunnel
sudo systemctl status uptunnel --no-pager
```

### Option B: Using PM2

If you prefer PM2 to manage your Node.js processes:

```bash
# 1. Install PM2 globally if you haven't already
sudo npm install -g pm2

# 2. Start the server with the ecosystem file
cd ~/up-tunnel/server
pm2 start ecosystem.config.cjs

# 3. Save the PM2 process list and configure it to start on boot
pm2 save
pm2 startup
```

After pulling new code, one command rebuilds `dist/` and restarts the process on it:

```bash
cd ~/up-tunnel/server
npm run start:prod    # tsc -p tsconfig.json && pm2 startOrRestart ecosystem.config.cjs --update-env
```

`startOrRestart` also covers the first run, so it works whether or not `uptunnel` is already
under PM2. Skipping the build is the classic way to restart onto a stale `dist/` and wonder
why the fix did not land — `dist/` is gitignored and never arrives with a `git pull`.

*(Note: The `--env-file` flag requires Node.js 20.6.0 or higher. If you are using an older version, you will need to use a package like `dotenv` or load the variables into the shell before running PM2).*

---

Verify:

```bash
curl -s localhost:8082/healthz              # -> ok
curl -s localhost:8082/status | jq          # agents and tunnels (empty for now)
curl -s localhost:8082/status | jq '.agents[] | {name, lanIp, remoteAddr}'  # where each device lives
curl -sI https://tunnel.example.com/healthz # -> 200 through nginx
sudo journalctl -u uptunnel -f              # live logs
```

If `/healthz` answers on both localhost and through nginx, the server is done. Move on to
[CLIENT-SETUP.md](CLIENT-SETUP.md).

---

## Operating it

```bash
sudo systemctl restart uptunnel        # after editing tokens.json or the env file
sudo journalctl -u uptunnel -f         # live logs
sudo journalctl -u uptunnel --since '1 hour ago' | grep -i error
curl -s localhost:8082/status | jq '.tunnels[] | {public, target, openConns}'
```

The admin API binds `127.0.0.1` with no auth. Reach it over your own SSH session, or set
`ADMIN_TOKEN` and send `Authorization: Bearer <token>` if you must expose it.

### Upgrading

```bash
cd ~/up-tunnel && git pull
cd server && npm ci --omit=dev
npm install --no-save typescript @types/node @types/ws
npx tsc -p tsconfig.json
sudo systemctl restart uptunnel
```

Agents reconnect on their own within a few seconds, so a restart costs a brief blip rather
than manual intervention on every device.

### Tuning

| Variable          | Default | Raise it when |
|-------------------|---------|---------------|
| `STREAM_WINDOW`   | 262144  | high-latency links feel slow — this is the per-stream credit window, and throughput is bounded by window ÷ round-trip time |
| `WS_MAX_BUFFERED` | 8388608 | you have RAM to spare and many concurrent streams per device |
| `HEARTBEAT_MS`    | 30000   | mobile/LTE devices get dropped too eagerly |
| `HEARTBEAT_MISSES`| 10      | flaky links drop a pong now and then — each extra miss buys one more `HEARTBEAT_MS` of grace before the subdomain is freed. Lower it only if you need dead sessions reaped faster than the default ~5 minutes; agents reconnect on their own schedule regardless |

### The health log

`HEALTH_LOG_FILE` (default `health.log` in the working directory, empty to disable) records the
connection lifecycle and nothing else: server start, agent connect/disconnect with the
close code, every heartbeat pong with its round trip, heartbeat misses and terminations,
tunnel open/close, and `subdomain_taken` refusals.

It is separate from `journalctl` on purpose. Journald owns the general chatter; this file
answers one specific question — *the device says it was connected and the URL returned 502,
so which end gave up and when?* — and it does so on a box where nobody configured log
rotation, because it is capped at `HEALTH_LOG_MAX_LINES` (default 10000) and trims to the
newest 80%. The agents write a matching log of their own; see
[CLIENT-SETUP.md](CLIENT-SETUP.md).

The default is relative so a local `npm run dev` just works — no `sudo mkdir`, no write
permission on `/var/log`. Under systemd the working directory is read-only
(`ProtectSystem=strict`), so set an absolute path in the env file as the sample above does;
the unit grants `ReadWritePaths=/var/log/uptunnel` to match. Read it with
`tail -f /var/log/uptunnel/health.log`. If the configured path is not writable the server
logs `health log unavailable` once and carries on without the file.

`STREAM_WINDOW` is the main throughput knob. At 256 KiB with a 100 ms round trip you top out
near 2.5 MB/s per stream; doubling the window doubles that ceiling at the cost of memory per
stalled stream.
