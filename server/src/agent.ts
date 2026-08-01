import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";

import { WebSocket } from "ws";

import type { Config, TokenEntry } from "./config.js";
import { logger, type Logger } from "./log.js";
import { FrameType, encodeStreamJson, type Frame } from "./protocol.js";
import { Stream, type StreamPeer } from "./stream.js";
import type { Tunnel } from "./types.js";

const MAX_STREAM_ID = 0xffff_fffe;

/** How often we re-check a congested socket before letting streams flow again. */
const CONGESTION_POLL_MS = 25;

export interface AgentSessionHooks {
  onOpenTunnel(agent: AgentSession, body: Record<string, unknown>): void;
  onCloseTunnel(agent: AgentSession, body: Record<string, unknown>): void;
  onClosed(agent: AgentSession): void;
}

/**
 * One connected device. Owns the WebSocket, the streams multiplexed over it, and the
 * tunnels registered through it.
 */
export class AgentSession implements StreamPeer {
  readonly id = `ag_${randomBytes(6).toString("hex")}`;
  readonly connectedAt = Date.now();
  readonly tunnels = new Map<string, Tunnel>();

  private readonly streams = new Map<number, Stream>();
  /** streamId -> tunnel, so we can decrement the right counter when a stream ends. */
  private readonly streamTunnels = new Map<number, Tunnel>();
  private nextStreamId = 1;
  private congested = false;
  private congestionTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly log: Logger;

  /** Set by HELLO; the client-declared label, distinct from the token's label. */
  clientName: string;
  clientVersion = "unknown";

  constructor(
    private readonly ws: WebSocket,
    readonly token: TokenEntry,
    readonly remoteAddr: string,
    private readonly cfg: Config,
    private readonly hooks: AgentSessionHooks,
  ) {
    this.clientName = token.name;
    this.log = logger("agent").child(this.id);
  }

  get logger(): Logger {
    return this.log;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  send(frame: Buffer): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(frame, { binary: true });
    this.checkCongestion();
  }

  // ---- streams --------------------------------------------------------------

  /**
   * Bridges an accepted public connection to the agent. `preread` is any bytes already
   * consumed from the socket (the HTTP frontend peeks the request head).
   */
  openStream(tunnel: Tunnel, socket: Socket, preread?: Buffer): Stream | null {
    const id = this.allocStreamId();
    if (id === null) {
      this.log.error("stream id space exhausted, dropping connection");
      socket.destroy();
      return null;
    }

    const remoteAddr = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
    this.send(
      encodeStreamJson(FrameType.StreamOpen, id, { tunnelId: tunnel.id, remoteAddr }),
    );

    const stream = new Stream(id, socket, this, tunnel, this.cfg.streamWindow);
    this.streams.set(id, stream);
    this.streamTunnels.set(id, tunnel);
    tunnel.openConns += 1;
    tunnel.totalConns += 1;

    if (this.congested) stream.setGlobalPause(true);
    if (preread && preread.length > 0) stream.writePreread(preread);
    socket.resume();

    this.log.debug("stream opened", { streamId: id, tunnel: tunnel.id, from: remoteAddr });
    return stream;
  }

  onStreamFinished(id: number): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    const tunnel = this.streamTunnels.get(id);
    if (tunnel) {
      tunnel.openConns = Math.max(0, tunnel.openConns - 1);
      this.streamTunnels.delete(id);
    }
    this.log.debug("stream closed", { streamId: id });
  }

  private allocStreamId(): number | null {
    for (let i = 0; i < 1024; i++) {
      const id = this.nextStreamId;
      this.nextStreamId = this.nextStreamId >= MAX_STREAM_ID ? 1 : this.nextStreamId + 1;
      if (!this.streams.has(id)) return id;
    }
    return null;
  }

  // ---- inbound frames -------------------------------------------------------

  handleFrame(frame: Frame): void {
    if (frame.kind === "control") {
      switch (frame.type) {
        case FrameType.OpenTunnel:
          this.hooks.onOpenTunnel(this, frame.body);
          return;
        case FrameType.CloseTunnel:
          this.hooks.onCloseTunnel(this, frame.body);
          return;
        case FrameType.Error:
          this.log.warn("agent reported an error", frame.body);
          return;
        default:
          // Unknown types are ignored so newer agents can add frames safely.
          this.log.debug("ignoring unknown control frame", { type: frame.type });
          return;
      }
    }

    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      // Racing close: the public socket went away while the agent was still writing.
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
        this.log.debug("ignoring unknown stream frame", { type: frame.type });
    }
  }

  // ---- congestion on the shared socket --------------------------------------

  private checkCongestion(): void {
    if (this.congested || this.ws.bufferedAmount <= this.cfg.wsMaxBuffered) return;

    this.congested = true;
    this.log.warn("agent socket congested, pausing all streams", {
      buffered: this.ws.bufferedAmount,
      streams: this.streams.size,
    });
    for (const s of this.streams.values()) s.setGlobalPause(true);

    const lowWater = Math.floor(this.cfg.wsMaxBuffered / 2);
    this.congestionTimer = setInterval(() => {
      if (this.closed || this.ws.bufferedAmount <= lowWater) {
        this.clearCongestion();
      }
    }, CONGESTION_POLL_MS);
  }

  private clearCongestion(): void {
    if (this.congestionTimer) {
      clearInterval(this.congestionTimer);
      this.congestionTimer = null;
    }
    if (!this.congested) return;
    this.congested = false;
    for (const s of this.streams.values()) s.setGlobalPause(false);
  }

  // ---- teardown -------------------------------------------------------------

  close(code: number, reason: string): void {
    if (this.closed) return;
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  /** Called once the WebSocket is gone: tear down streams and release tunnels. */
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearCongestion();
    for (const stream of [...this.streams.values()]) stream.destroy("agent_gone");
    this.streams.clear();
    this.streamTunnels.clear();
    this.hooks.onClosed(this);
    this.log.info("agent disconnected", {
      name: this.clientName,
      uptimeSec: Math.round((Date.now() - this.connectedAt) / 1000),
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
