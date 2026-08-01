# Recipes

Practical things to do once the server and an agent are running.

Every command here works with either agent — the Python one in `client/` and the Node one in
`client-node/` take the same flags and the same config file. See
[CLIENT-SETUP.md](CLIENT-SETUP.md) for installing them.

---

## Share a local web app

```bash
uptunnel http 3000 --subdomain demo
# -> https://demo.tun.example.com
```

For a framework dev server, add `--rewrite-host`. Vite, webpack-dev-server, Angular and
Rails all reject requests whose `Host` they don't recognise, and would otherwise answer
"Invalid Host header" or a blank page:

```bash
uptunnel http 5173 --subdomain demo --rewrite-host
```

The flag makes the agent rewrite `Host:` to `127.0.0.1:5173` on the way to the local server.
The visitor's browser is unaffected.

## Receive a webhook

Stripe, GitHub and Twilio need a public HTTPS URL that they can reach:

```bash
uptunnel http 4000 --subdomain hooks
# register https://hooks.tun.example.com/webhook with the provider
```

Since subdomains are stable, the URL survives restarts — unlike a free ngrok URL, so you
register it once.

## SSH into a machine behind NAT

On the device:

```bash
uptunnel tcp 22 --remote-port 20022
```

From anywhere:

```bash
ssh -p 20022 pi@tunnel.example.com
scp -P 20022 bigfile.tar pi@tunnel.example.com:~/
sftp -P 20022 pi@tunnel.example.com
```

`~/.ssh/config` makes it disappear into normal usage:

```
Host mypi
    HostName tunnel.example.com
    Port 20022
    User pi
    ServerAliveInterval 30
```

…then `ssh mypi`, `scp file mypi:~/`, `rsync -av dir/ mypi:~/dir/`, and VS Code Remote-SSH
all work.

`ServerAliveInterval 30` is worth setting: it keeps an idle session alive through NAT
timeouts on the path.

Verified working over the tunnel: remote commands, `scp` (20 MB byte-identical), `sftp`, PTY
allocation, and nested `ssh -L` forwarding.

## Reach a whole LAN through one SSH tunnel

Expose only SSH, then forward from there. One public port, and everything inside is
protected by your SSH key:

```bash
# on the device
uptunnel tcp 22 --remote-port 20022
```

```bash
# from your laptop: the Pi's router admin page appears on localhost:8080
ssh -p 20022 -L 8080:192.168.1.1:80 pi@tunnel.example.com
```

Or a SOCKS proxy for the whole remote network:

```bash
ssh -p 20022 -D 1080 pi@tunnel.example.com
# then point a browser at SOCKS5 127.0.0.1:1080
```

## MQTT for IoT devices

```bash
uptunnel tcp 1883 --remote-port 20083
mosquitto_pub -h tunnel.example.com -p 20083 -t sensors/temp -m 21.5
```

The broker stays on your Pi; only the port is public. Turn on broker authentication — this
port is reachable by anyone.

## A database, temporarily

```bash
uptunnel tcp 5432 --remote-port 20054
psql -h tunnel.example.com -p 20054 -U postgres mydb
```

Use this for a short debugging session, not permanently. A public Postgres port is a
credential-stuffing target; prefer the SSH-forwarding recipe above.

## Several services at once

One WebSocket carries all of them:

```yaml
server: wss://tunnel.example.com/control
token: the-secret-for-this-device
tunnels:
  - { name: api,  kind: http, subdomain: api-dev, target: 8000 }
  - { name: web,  kind: http, subdomain: web-dev, target: 3000, rewrite_host: true }
  - { name: ssh,  kind: tcp,  remote_port: 20022, target: 22 }
  - { name: mqtt, kind: tcp,  remote_port: 20083, target: 1883 }
```

```bash
uptunnel
```

## WebSockets and streaming

No configuration needed. The server pipes raw bytes after reading the `Host` header, so
WebSocket upgrades, Server-Sent Events, long-polling and chunked responses pass through
untouched:

```js
new WebSocket("wss://demo.tun.example.com/socket");   // just works
```

Verified: 512 KiB WebSocket frames round-trip intact, and SSE events arrive as the server
emits them rather than buffered to the end.

## Expose another machine on your LAN

The agent doesn't have to run on the machine being exposed:

```bash
uptunnel http 192.168.1.50:80  --subdomain nas
uptunnel tcp  192.168.1.10:22  --remote-port 20023
```

Useful for a printer, a NAS, or an appliance you can't install anything on.

---

## Checking on things

On the server:

```bash
curl -s localhost:8082/status | jq
curl -s localhost:8082/status | jq '.tunnels[] | {public, target, openConns, totalConns}'
sudo journalctl -u uptunnel -f
```

```json
{
  "agents": [
    { "name": "macbook", "remoteAddr": "1.2.3.4", "connectedSec": 3610,
      "openStreams": 2, "tunnels": 2 }
  ],
  "tunnels": [
    { "public": "https://mac.tun.example.com", "target": "127.0.0.1:3000",
      "openConns": 1, "totalConns": 214, "bytesFromAgent": 65134851 }
  ]
}
```

On the client, `-v` shows per-stream activity and `-vv` adds raw WebSocket frames.

---

## Things to keep in mind

**A tunnel is a hole through your NAT.** Anyone who guesses the subdomain reaches the
service. Don't tunnel an unauthenticated admin panel and treat the URL as a secret — put
real auth on the service, or keep it behind key-based SSH.

**One `Host` label only.** `a.b.tun.example.com` won't route, and a Let's Encrypt wildcard
wouldn't cover it either.

**No rate limiting yet.** A busy tunnel can saturate the box.

**Subdomains are first-come.** A second agent claiming a live subdomain is rejected with
`subdomain_taken`; per-token `subdomains` grants in `tokens.json` prevent devices from
competing at all.
