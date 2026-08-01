import { connect, type Socket } from "node:net";

import { targetLabel, type TunnelSpec } from "./config.js";
import { log } from "./log.js";
import {
  FrameType,
  encodeStreamAck,
  encodeStreamData,
  encodeStreamJson,
  encodeStreamOnly,
} from "./protocol.js";

const LOCAL_CONNECT_TIMEOUT_MS = 10_000;
const MAX_HEAD_BUFFER = 32 * 1024;

/** What a stream needs from the agent, kept narrow to avoid an import cycle. */
export interface StreamPeer {
  send(frame: Buffer): void;
  onStreamFinished(id: number): void;
}

/**
 * One tunnelled connection, bridged between the agent's WebSocket and a local socket.
 *
 * Both directions are credit-limited (docs/PROTOCOL.md § Flow control): we stop sending
 * when the server's grant runs out, and we only grant the server more once our local
 * socket has actually accepted what it sent.
 */
export class ClientStream {
  private socket: Socket | null = null;
  private connected = false;
  private sendCredit: number;
  private recvUnacked = 0;
  private pausedForCredit = false;
  private pausedGlobally = false;
  private sentEof = false;
  private receivedEof = false;
  private finished = false;

  /** Frames that arrive while the local connection is still being established. */
  private queued: Buffer[] = [];
  private queuedEof = false;

  /** Host-header rewriting has to hold the request head back until it's complete. */
  private headBuf: Buffer[] = [];
  private headLen = 0;
  private headDone: boolean;

  constructor(
    readonly id: number,
    private readonly spec: TunnelSpec,
    private readonly peer: StreamPeer,
    window: number,
  ) {
    this.sendCredit = window;
    this.headDone = !(spec.kind === "http" && spec.rewriteHost);
  }

  // ---- establishing the local connection ------------------------------------

  open(): void {
    const socket = connect({ host: this.spec.targetHost, port: this.spec.targetPort });
    socket.setNoDelay(true);

    const timer = setTimeout(() => {
      socket.destroy();
      this.dialFailed(`connect to ${targetLabel(this.spec)} timed out`);
    }, LOCAL_CONNECT_TIMEOUT_MS);

    socket.once("connect", () => {
      clearTimeout(timer);
      this.attach(socket);
    });

    socket.once("error", (err) => {
      clearTimeout(timer);
      if (!this.connected) this.dialFailed(`${targetLabel(this.spec)}: ${err.message}`);
    });
  }

  private dialFailed(message: string): void {
    if (this.finished) return;
    this.finished = true;
    log.warn(`stream ${this.id}: ${message}`);
    this.peer.send(
      encodeStreamJson(FrameType.StreamReset, this.id, { code: "dial_failed", message }),
    );
    this.peer.onStreamFinished(this.id);
  }

  private attach(socket: Socket): void {
    if (this.finished) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    this.connected = true;
    log.debug(`stream ${this.id}: connected to ${targetLabel(this.spec)}`);

    socket.on("data", (chunk: Buffer) => this.onLocalData(chunk));
    socket.on("end", () => this.onLocalEnd());
    socket.on("drain", () => this.flushAck());
    socket.on("error", () => this.destroy("local_error"));
    socket.on("close", () => this.finish());

    for (const frame of this.queued) this.writeLocal(frame);
    this.queued = [];
    if (this.queuedEof) this.onEof();

    if (this.pausedGlobally) socket.pause();
  }

  // ---- local -> server ------------------------------------------------------

  private onLocalData(chunk: Buffer): void {
    if (this.finished || this.sentEof) return;
    this.peer.send(encodeStreamData(this.id, chunk));

    this.sendCredit -= chunk.length;
    if (this.sendCredit <= 0 && !this.pausedForCredit) {
      this.pausedForCredit = true;
      this.socket?.pause();
    }
  }

  private onLocalEnd(): void {
    if (this.finished || this.sentEof) return;
    this.sentEof = true;
    this.peer.send(encodeStreamOnly(FrameType.StreamEof, this.id));
    if (this.receivedEof) this.finish();
  }

  onAck(bytes: number): void {
    if (this.finished) return;
    this.sendCredit += bytes;
    this.maybeResume();
  }

  // ---- server -> local ------------------------------------------------------

  onData(payload: Buffer): void {
    if (this.finished || this.receivedEof) return;
    if (!this.connected) {
      this.queued.push(payload);
      return;
    }
    this.writeLocal(payload);
  }

  private writeLocal(payload: Buffer): void {
    // Credit accounting is on bytes received, independent of how many we write locally —
    // the head buffer below can hold some back for a moment.
    this.recvUnacked += payload.length;

    const out = this.headDone ? payload : this.consumeHead(payload);
    if (out.length === 0) {
      this.flushAck();
      return;
    }
    if (this.socket!.write(out)) this.flushAck();
  }

  /** Buffers until the request head is complete, then rewrites its Host line. */
  private consumeHead(chunk: Buffer): Buffer {
    this.headBuf.push(chunk);
    this.headLen += chunk.length;
    const head = this.headBuf.length === 1 ? this.headBuf[0]! : Buffer.concat(this.headBuf);

    if (head.indexOf("\r\n\r\n") === -1 && this.headLen < MAX_HEAD_BUFFER) return Buffer.alloc(0);

    this.headBuf = [];
    this.headLen = 0;
    this.headDone = true;
    return rewriteHostHeader(head, targetLabel(this.spec));
  }

  onEof(): void {
    if (this.finished || this.receivedEof) return;
    if (!this.connected) {
      this.queuedEof = true;
      return;
    }
    this.receivedEof = true;
    // Anything still held back for a Host rewrite has to go out before the half-close.
    if (this.headBuf.length > 0) {
      const head = Buffer.concat(this.headBuf);
      this.headBuf = [];
      this.headDone = true;
      this.socket!.write(rewriteHostHeader(head, targetLabel(this.spec)));
    }
    this.flushAck();
    this.socket!.end();
    if (this.sentEof) this.finish();
  }

  private flushAck(): void {
    if (this.recvUnacked === 0 || this.finished) return;
    const n = this.recvUnacked;
    this.recvUnacked = 0;
    this.peer.send(encodeStreamAck(this.id, n));
  }

  // ---- backpressure on the shared WebSocket ---------------------------------

  setGlobalPause(paused: boolean): void {
    if (this.pausedGlobally === paused || this.finished) return;
    this.pausedGlobally = paused;
    if (paused) this.socket?.pause();
    else this.maybeResume();
  }

  private maybeResume(): void {
    if (this.finished || this.pausedGlobally || this.sendCredit <= 0) return;
    if (!this.pausedForCredit) return;
    this.pausedForCredit = false;
    this.socket?.resume();
  }

  // ---- teardown -------------------------------------------------------------

  onReset(): void {
    this.destroy("peer_reset");
  }

  /** Aborts both directions. "peer_reset" skips telling the peer. */
  destroy(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    if (reason !== "peer_reset") {
      this.peer.send(encodeStreamJson(FrameType.StreamReset, this.id, { code: reason }));
    }
    this.socket?.destroy();
    this.peer.onStreamFinished(this.id);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.peer.onStreamFinished(this.id);
  }
}

/** Replaces the first Host header value; leaves the rest of the head untouched. */
export function rewriteHostHeader(head: Buffer, target: string): Buffer {
  // latin1 is a byte-preserving round trip, so a header rewrite can't corrupt a body.
  const text = head.toString("latin1");
  const replaced = text.replace(/^Host:[^\r\n]*/im, `Host: ${target}`);
  return replaced === text ? head : Buffer.from(replaced, "latin1");
}
