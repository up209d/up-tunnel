import { WebSocket } from "ws";

import { targetLabel, type AgentConfig, type TunnelSpec } from "./config.js";
import { log } from "./log.js";
import { ClientStream, type StreamPeer } from "./stream.js";
import {
  FRAME_NAMES,
  FrameType,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeFrame,
  encodeControl,
  encodeStreamJson,
  streamFrameJson,
  type Frame,
} from "./protocol.js";

export const CLIENT_ID = "uptunnel-node/0.1.0";

const HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * We ping this often and drop the socket if the previous ping went unanswered, so a dead
 * link is noticed within two intervals rather than waiting on TCP's own timeouts.
 */
const PING_INTERVAL_MS = 20_000;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/**
 * A session has to stay up this long before we treat it as healthy and reset the backoff.
 * Without this, a server that accepts connections and immediately drops them would be
 * hammered once a second forever, because every attempt "succeeded".
 */
const STABLE_SESSION_MS = 30_000;

const WS_MAX_BUFFERED = 8 * 1024 * 1024;
const CONGESTION_POLL_MS = 25;

/** Credentials were rejected — retrying will never help, so stop. */
export class AuthError extends Error {}

export class Agent implements StreamPeer {
  private ws: WebSocket | null = null;
  private readonly streams = new Map<number, ClientStream>();
  /** tunnelId -> the spec we registered under it, so STREAM_OPEN knows where to dial. */
  private readonly tunnels = new Map<string, TunnelSpec>();
  /** reqId -> spec, pending a TUNNEL_OK or ERROR reply. */
  private readonly pending = new Map<string, TunnelSpec>();
  private window = 256 * 1024;
  private congested = false;
  private congestionTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly cfg: AgentConfig) {}

  // ---- lifecycle ------------------------------------------------------------

  async runForever(): Promise<void> {
    let delay = RECONNECT_MIN_MS;

    while (!this.stopping) {
      const startedAt = Date.now();
      try {
        await this.session();
        if (this.stopping) return;
        log.warn("server closed the connection");
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (this.stopping) return;
        log.warn(`disconnected: ${(err as Error).message}`);
      }

      // Only a session that actually held up earns a reset back to the minimum.
      if (Date.now() - startedAt >= STABLE_SESSION_MS) delay = RECONNECT_MIN_MS;

      // Jitter keeps a fleet of devices from all reconnecting on the same tick after a
      // server restart.
      const wait = delay * (0.7 + Math.random() * 0.6);
      log.info(`reconnecting in ${(wait / 1000).toFixed(0)}s`);
      await sleep(wait);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  stop(): void {
    this.stopping = true;
    this.ws?.close(1000, "client_shutdown");
  }

  private session(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      log.info(`connecting to ${this.cfg.server}`);

      const ws = new WebSocket(this.cfg.server, {
        perMessageDeflate: false,
        maxPayload: 4 * 1024 * 1024,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        rejectUnauthorized: !this.cfg.insecure,
      });
      this.ws = ws;

      let settled = false;
      let handshook = false;
      let alive = true;
      let ping: NodeJS.Timeout | null = null;
      let handshakeTimer: NodeJS.Timeout | null = null;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (ping) clearInterval(ping);
        if (handshakeTimer) clearTimeout(handshakeTimer);
        this.teardownSession();
        if (err) reject(err);
        else resolve();
      };

      ws.on("open", () => {
        ws.send(
          encodeControl(FrameType.Hello, {
            version: PROTOCOL_VERSION,
            token: this.cfg.token,
            name: this.cfg.name,
            client: CLIENT_ID,
          }),
          { binary: true },
        );
        handshakeTimer = setTimeout(() => {
          if (!handshook) {
            ws.terminate();
            finish(new Error("server did not answer the handshake"));
          }
        }, HANDSHAKE_TIMEOUT_MS);
      });

      ws.on("pong", () => {
        alive = true;
      });

      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          log.warn("ignoring a non-binary frame from the server");
          return;
        }
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);

        let frame: Frame;
        try {
          frame = decodeFrame(buf);
        } catch (err) {
          if (err instanceof ProtocolError) {
            log.warn(`bad frame from server: ${err.message}`);
            return;
          }
          throw err;
        }

        if (!handshook) {
          const fatal = this.handleHandshake(frame);
          if (fatal) {
            ws.close(1000, "handshake_failed");
            finish(fatal);
            return;
          }
          handshook = true;
          if (handshakeTimer) clearTimeout(handshakeTimer);

          this.registerTunnels();

          // Our own liveness check, independent of the server's. Detects a black-holed
          // link (sleeping laptop, dropped LTE) rather than waiting on TCP timeouts.
          ping = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (!alive) {
              log.warn("server missed heartbeat, reconnecting");
              ws.terminate();
              return;
            }
            alive = false;
            ws.ping();
          }, PING_INTERVAL_MS);
          return;
        }

        this.handleFrame(frame);
      });

      ws.on("close", (code) => {
        if (code === 4001 || code === 4002) {
          finish(new AuthError(`server rejected the connection (code ${code})`));
          return;
        }
        finish();
      });

      ws.on("error", (err) => finish(err));
    });
  }

  private handleHandshake(frame: Frame): Error | null {
    if (frame.kind !== "control") return new Error("expected a control frame during handshake");

    if (frame.type === FrameType.Error) {
      const code = String(frame.body.code ?? "error");
      const message = String(frame.body.message ?? "");
      if (code === "unauthorized" || code === "bad_version") {
        return new AuthError(`${code}: ${message}`);
      }
      return new Error(`handshake failed: ${code} ${message}`);
    }

    if (frame.type !== FrameType.HelloOk) {
      return new Error(`expected HELLO_OK, got ${FRAME_NAMES[frame.type] ?? frame.type}`);
    }

    const advertised = Number(frame.body.streamWindow);
    if (Number.isInteger(advertised) && advertised > 0) this.window = advertised;
    log.info(
      `connected as ${this.cfg.name} (agent ${frame.body.agentId ?? "?"}, ` +
        `window ${Math.round(this.window / 1024)}KiB)`,
    );
    return null;
  }

  private registerTunnels(): void {
    this.cfg.tunnels.forEach((spec, i) => {
      const reqId = String(i);
      this.pending.set(reqId, spec);
      const body: Record<string, unknown> = {
        reqId,
        kind: spec.kind,
        target: { host: spec.targetHost, port: spec.targetPort },
      };
      if (spec.kind === "http") body.subdomain = spec.subdomain;
      else if (spec.remotePort) body.remotePort = spec.remotePort;
      this.send(encodeControl(FrameType.OpenTunnel, body));
    });
  }

  // ---- frames ---------------------------------------------------------------

  private handleFrame(frame: Frame): void {
    if (frame.kind === "control") {
      switch (frame.type) {
        case FrameType.TunnelOk:
          this.onTunnelOk(frame.body);
          return;
        case FrameType.Error:
          this.onError(frame.body);
          return;
        default:
          log.debug(`ignoring control frame ${FRAME_NAMES[frame.type] ?? frame.type}`);
          return;
      }
    }

    if (frame.type === FrameType.StreamOpen) {
      this.onStreamOpen(frame.streamId, streamFrameJson(frame.payload));
      return;
    }

    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      // The server may still be draining a stream we already tore down.
      if (frame.type !== FrameType.StreamReset) {
        this.send(
          encodeStreamJson(FrameType.StreamReset, frame.streamId, { code: "unknown_stream" }),
        );
      }
      return;
    }

    switch (frame.type) {
      case FrameType.StreamData:
        stream.onData(frame.payload);
        return;
      case FrameType.StreamEof:
        stream.onEof();
        return;
      case FrameType.StreamAck:
        if (frame.payload.length >= 4) stream.onAck(frame.payload.readUInt32BE(0));
        return;
      case FrameType.StreamReset:
        stream.onReset();
        return;
      default:
        log.debug(`ignoring stream frame ${FRAME_NAMES[frame.type] ?? frame.type}`);
    }
  }

  private onTunnelOk(body: Record<string, unknown>): void {
    const reqId = String(body.reqId ?? "");
    const spec = this.pending.get(reqId);
    this.pending.delete(reqId);

    const tunnelId = String(body.tunnelId ?? "");
    if (spec && tunnelId) this.tunnels.set(tunnelId, spec);

    const where = body.publicUrl ?? `${body.publicHost ?? "?"}:${body.publicPort ?? "?"}`;
    const name = (spec?.name ?? "?").padEnd(10);
    log.info(`${name} ${where}  ->  ${spec ? targetLabel(spec) : "?"}`);
  }

  private onError(body: Record<string, unknown>): void {
    const reqId = String(body.reqId ?? "");
    const spec = this.pending.get(reqId);
    this.pending.delete(reqId);
    const label = spec?.name ?? "server";
    log.error(`${label}: ${body.message ?? ""} (${body.code ?? "error"})`);
  }

  private onStreamOpen(streamId: number, meta: Record<string, unknown>): void {
    const spec = this.tunnels.get(String(meta.tunnelId ?? ""));
    if (!spec) {
      this.send(encodeStreamJson(FrameType.StreamReset, streamId, { code: "unknown_tunnel" }));
      return;
    }
    const stream = new ClientStream(streamId, spec, this, this.window);
    this.streams.set(streamId, stream);
    if (this.congested) stream.setGlobalPause(true);
    stream.open();
  }

  // ---- StreamPeer -----------------------------------------------------------

  send(frame: Buffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(frame, { binary: true });
    this.checkCongestion();
  }

  onStreamFinished(id: number): void {
    this.streams.delete(id);
    log.debug(`stream ${id}: closed`);
  }

  // ---- congestion -----------------------------------------------------------

  private checkCongestion(): void {
    const ws = this.ws;
    if (!ws || this.congested || ws.bufferedAmount <= WS_MAX_BUFFERED) return;

    this.congested = true;
    log.warn(`uplink congested (${ws.bufferedAmount} bytes queued), pausing all streams`);
    for (const stream of this.streams.values()) stream.setGlobalPause(true);

    const lowWater = Math.floor(WS_MAX_BUFFERED / 2);
    this.congestionTimer = setInterval(() => {
      if (!this.ws || this.ws.bufferedAmount <= lowWater) this.clearCongestion();
    }, CONGESTION_POLL_MS);
  }

  private clearCongestion(): void {
    if (this.congestionTimer) {
      clearInterval(this.congestionTimer);
      this.congestionTimer = null;
    }
    if (!this.congested) return;
    this.congested = false;
    for (const stream of this.streams.values()) stream.setGlobalPause(false);
  }

  private teardownSession(): void {
    this.clearCongestion();
    for (const stream of [...this.streams.values()]) stream.destroy("peer_reset");
    this.streams.clear();
    this.tunnels.clear();
    this.pending.clear();
    this.ws = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
