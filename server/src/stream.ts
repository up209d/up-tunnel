import type { Socket } from "node:net";

import {
  FrameType,
  encodeStreamAck,
  encodeStreamData,
  encodeStreamJson,
  encodeStreamOnly,
} from "./protocol.js";

/** What a Stream needs from its owning agent session, kept narrow to avoid an import cycle. */
export interface StreamPeer {
  send(frame: Buffer): void;
  onStreamFinished(id: number): void;
}

export interface StreamCounters {
  bytesToAgent: number;
  bytesFromAgent: number;
}

/**
 * One tunnelled connection: a public-side TCP socket bridged to a stream id on the
 * agent's WebSocket.
 *
 * Both directions are credit-limited (see docs/PROTOCOL.md § Flow control). We only ever
 * send as many bytes as the agent has granted, and we only grant the agent more once our
 * public socket has actually accepted what it sent.
 */
export class Stream {
  private sendCredit: number;
  private recvUnacked = 0;
  private pausedForCredit = false;
  private pausedGlobally = false;
  private sentEof = false;
  private receivedEof = false;
  private finished = false;

  constructor(
    readonly id: number,
    private readonly socket: Socket,
    private readonly peer: StreamPeer,
    private readonly counters: StreamCounters,
    window: number,
  ) {
    this.sendCredit = window;
    socket.setNoDelay(true);

    socket.on("data", (chunk: Buffer) => this.onSocketData(chunk));
    socket.on("end", () => this.onSocketEnd());
    socket.on("drain", () => this.flushAck());
    socket.on("error", () => this.destroy("socket_error"));
    socket.on("close", () => this.finish());
  }

  // ---- public side -> agent -------------------------------------------------

  private onSocketData(chunk: Buffer): void {
    if (this.finished || this.sentEof) return;
    this.counters.bytesToAgent += chunk.length;
    this.peer.send(encodeStreamData(this.id, chunk));

    this.sendCredit -= chunk.length;
    if (this.sendCredit <= 0 && !this.pausedForCredit) {
      this.pausedForCredit = true;
      this.socket.pause();
    }
  }

  private onSocketEnd(): void {
    if (this.finished || this.sentEof) return;
    this.sentEof = true;
    this.peer.send(encodeStreamOnly(FrameType.StreamEof, this.id));
    if (this.receivedEof) this.finish();
  }

  /**
   * Injects bytes already read off the socket before the stream existed — the HTTP
   * frontend has to consume the request head to find the Host header.
   */
  writePreread(head: Buffer): void {
    if (head.length === 0) return;
    this.onSocketData(head);
  }

  // ---- agent -> public side -------------------------------------------------

  onData(payload: Buffer): void {
    if (this.finished || this.receivedEof) return;
    this.counters.bytesFromAgent += payload.length;
    const flushed = this.socket.write(payload);
    this.recvUnacked += payload.length;
    // Ack only once the socket has taken the bytes, otherwise credit stops meaning
    // anything and a slow public client can no longer slow the agent down.
    if (flushed) this.flushAck();
  }

  onEof(): void {
    if (this.finished || this.receivedEof) return;
    this.receivedEof = true;
    this.flushAck();
    this.socket.end();
    if (this.sentEof) this.finish();
  }

  onAck(bytes: number): void {
    if (this.finished) return;
    this.sendCredit += bytes;
    this.maybeResume();
  }

  onReset(): void {
    this.destroy("peer_reset");
  }

  private flushAck(): void {
    if (this.recvUnacked === 0 || this.finished) return;
    const n = this.recvUnacked;
    this.recvUnacked = 0;
    this.peer.send(encodeStreamAck(this.id, n));
  }

  // ---- backpressure on the shared WebSocket --------------------------------

  /** Applied to every stream when the agent's socket has too much queued. */
  setGlobalPause(paused: boolean): void {
    if (this.pausedGlobally === paused || this.finished) return;
    this.pausedGlobally = paused;
    if (paused) this.socket.pause();
    else this.maybeResume();
  }

  private maybeResume(): void {
    if (this.finished || this.pausedGlobally || this.sendCredit <= 0) return;
    if (!this.pausedForCredit) return;
    this.pausedForCredit = false;
    this.socket.resume();
  }

  // ---- teardown ------------------------------------------------------------

  /** Aborts both directions. `reason` of "peer_reset" skips telling the peer. */
  destroy(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    if (reason !== "peer_reset") {
      this.peer.send(encodeStreamJson(FrameType.StreamReset, this.id, { code: reason }));
    }
    this.socket.destroy();
    this.peer.onStreamFinished(this.id);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.peer.onStreamFinished(this.id);
  }

  get isFinished(): boolean {
    return this.finished;
  }
}
