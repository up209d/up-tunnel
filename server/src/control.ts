import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { AgentSession } from "./agent.js";
import type { Config, TokenEntry } from "./config.js";
import { logger } from "./log.js";
import {
  FrameType,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeFrame,
  encodeControl,
  type Frame,
} from "./protocol.js";
import type { Registry } from "./registry.js";
import { TunnelError } from "./types.js";

const log = logger("control");

/** An agent that connects but never says HELLO is dropped after this long. */
const HELLO_TIMEOUT_MS = 10_000;

const CLOSE_BAD_REQUEST = 4000;
const CLOSE_UNAUTHORIZED = 4001;
const CLOSE_BAD_VERSION = 4002;

/** Constant-time token comparison over SHA-256 digests, so lengths never leak. */
function tokenMatches(candidate: string, known: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(known).digest();
  return timingSafeEqual(a, b);
}

function findToken(cfg: Config, presented: unknown): TokenEntry | null {
  if (typeof presented !== "string" || presented.length === 0) return null;
  let found: TokenEntry | null = null;
  // Check every entry so timing doesn't reveal which token matched.
  for (const entry of cfg.tokens) {
    if (tokenMatches(presented, entry.token)) found = entry;
  }
  return found;
}

export class ControlPlane {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly sessions = new Set<AgentSession>();

  constructor(
    private readonly cfg: Config,
    private readonly registry: Registry,
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      // Tunnel payloads are usually already-compressed HTTP bodies; deflate would burn
      // CPU and add latency for nothing.
      perMessageDeflate: false,
      maxPayload: 4 * 1024 * 1024,
    });

    this.http = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    });

    this.http.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket as Duplex, head));
  }

  get agents(): Iterable<AgentSession> {
    return this.sessions;
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== this.cfg.controlPath) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    // Behind nginx the socket peer is the proxy, so prefer the forwarded client address.
    const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    const remoteAddr = forwarded || req.socket.remoteAddress || "unknown";

    let session: AgentSession | null = null;
    let alive = true;

    const helloTimer = setTimeout(() => {
      if (!session) {
        log.warn("no HELLO received, closing", { remoteAddr });
        ws.close(CLOSE_BAD_REQUEST, "hello_timeout");
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("pong", () => {
      alive = true;
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        this.reject(ws, CLOSE_BAD_REQUEST, "bad_request", "frames must be binary");
        return;
      }
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);

      let frame: Frame;
      try {
        frame = decodeFrame(buf);
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.reject(ws, CLOSE_BAD_REQUEST, "bad_request", err.message);
          return;
        }
        throw err;
      }

      if (!session) {
        if (frame.kind !== "control" || frame.type !== FrameType.Hello) {
          this.reject(ws, CLOSE_BAD_REQUEST, "bad_request", "expected HELLO first");
          return;
        }
        session = this.handshake(ws, frame.body, remoteAddr);
        if (session) clearTimeout(helloTimer);
        return;
      }

      session.handleFrame(frame);
    });

    const teardown = () => {
      clearTimeout(helloTimer);
      if (session) {
        this.sessions.delete(session);
        session.destroy();
      }
    };

    ws.on("close", teardown);
    ws.on("error", (err) => {
      log.warn("websocket error", { remoteAddr, err: err.message });
      teardown();
    });

    // Per-connection liveness: the shared interval below flips this to false, and a
    // missing pong on the next tick means the device is gone (common on flaky wifi/LTE).
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(ping);
        return;
      }
      if (!alive) {
        log.warn("agent missed heartbeat, terminating", { remoteAddr });
        clearInterval(ping);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.cfg.heartbeatMs);
    ws.on("close", () => clearInterval(ping));
  }

  private reject(ws: WebSocket, code: number, errCode: string, message: string): void {
    try {
      ws.send(encodeControl(FrameType.Error, { code: errCode, message }), { binary: true });
    } catch {
      /* socket already gone */
    }
    ws.close(code, errCode);
  }

  private handshake(
    ws: WebSocket,
    body: Record<string, unknown>,
    remoteAddr: string,
  ): AgentSession | null {
    const version = Number(body.version);
    if (version !== PROTOCOL_VERSION) {
      this.reject(
        ws,
        CLOSE_BAD_VERSION,
        "bad_version",
        `server speaks protocol v${PROTOCOL_VERSION}, agent offered v${body.version}`,
      );
      return null;
    }

    const token = findToken(this.cfg, body.token);
    if (!token) {
      log.warn("rejected unknown token", { remoteAddr, name: body.name });
      this.reject(ws, CLOSE_UNAUTHORIZED, "unauthorized", "token not recognised");
      return null;
    }

    const session = new AgentSession(ws, token, remoteAddr, this.cfg, {
      onOpenTunnel: (agent, req) => void this.openTunnel(agent, req),
      onCloseTunnel: (agent, req) => this.closeTunnel(agent, req),
      onClosed: (agent) => this.registry.closeAllFor(agent),
    });

    if (typeof body.name === "string" && body.name) session.clientName = body.name;
    if (typeof body.client === "string" && body.client) session.clientVersion = body.client;

    this.sessions.add(session);
    session.send(
      encodeControl(FrameType.HelloOk, {
        agentId: session.id,
        heartbeatMs: this.cfg.heartbeatMs,
        streamWindow: this.cfg.streamWindow,
        httpDomain: this.cfg.httpDomain,
        serverVersion: PROTOCOL_VERSION,
      }),
    );
    log.info("agent connected", {
      agentId: session.id,
      name: session.clientName,
      token: token.name,
      remoteAddr,
      client: session.clientVersion,
    });
    return session;
  }

  private async openTunnel(agent: AgentSession, body: Record<string, unknown>): Promise<void> {
    const reqId = typeof body.reqId === "string" ? body.reqId : undefined;
    try {
      const req = this.registry.parseRequest(body);
      const tunnel = await this.registry.open(agent, req);
      const ok: Record<string, unknown> = { reqId, tunnelId: tunnel.id, kind: tunnel.kind };
      if (tunnel.kind === "http") {
        ok.subdomain = tunnel.subdomain;
        ok.publicUrl = this.registry.publicUrl(tunnel);
      } else {
        ok.publicPort = tunnel.publicPort;
        ok.publicHost = this.cfg.publicTcpHost;
      }
      agent.send(encodeControl(FrameType.TunnelOk, ok));
    } catch (err) {
      const code = err instanceof TunnelError ? err.code : "bad_request";
      const message = (err as Error).message;
      agent.logger.warn("tunnel request rejected", { code, message });
      agent.send(encodeControl(FrameType.Error, { reqId, code, message }));
    }
  }

  private closeTunnel(agent: AgentSession, body: Record<string, unknown>): void {
    const id = typeof body.tunnelId === "string" ? body.tunnelId : "";
    const tunnel = agent.tunnels.get(id);
    if (!tunnel) {
      agent.send(
        encodeControl(FrameType.Error, { code: "bad_request", message: `no such tunnel ${id}` }),
      );
      return;
    }
    this.registry.close(tunnel);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.cfg.controlPort, this.cfg.controlHost, () => {
        log.info("control plane listening", {
          addr: `${this.cfg.controlHost}:${this.cfg.controlPort}${this.cfg.controlPath}`,
        });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const session of [...this.sessions]) session.close(1001, "server_shutdown");
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
