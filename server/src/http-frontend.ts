import { createServer, type Server, type Socket } from "node:net";

import type { Config } from "./config.js";
import { logger } from "./log.js";
import type { Registry } from "./registry.js";

const log = logger("http");

const HEAD_TERMINATOR = Buffer.from("\r\n\r\n");

/**
 * Public HTTP entry point. nginx terminates TLS for `*.<httpDomain>` and proxies here in
 * the clear.
 *
 * This is deliberately *not* an http.Server. We read just enough of the request to find
 * the Host header, then hand the raw byte stream to the agent untouched — which is what
 * makes WebSocket upgrades, SSE, chunked bodies and HTTP/1.1 pipelining work through the
 * tunnel without any special handling.
 *
 * That works because nginx opens a fresh upstream connection per request unless a
 * `keepalive` directive is configured on an upstream block (see deploy/nginx). One
 * connection therefore carries exactly one Host, so peeking once is sound.
 */
export class HttpFrontend {
  private readonly server: Server;
  private readonly hostSuffix: string;

  constructor(
    private readonly cfg: Config,
    private readonly registry: Registry,
  ) {
    this.hostSuffix = `.${cfg.httpDomain}`;
    this.server = createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) => log.error("listener error", { err: err.message }));
  }

  private onConnection(socket: Socket): void {
    socket.setNoDelay(true);
    // A device that never sends a complete request head must not hold a slot forever.
    socket.setTimeout(30_000, () => socket.destroy());

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      const head = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);

      const end = head.indexOf(HEAD_TERMINATOR);
      if (end === -1) {
        if (total > this.cfg.maxHttpHeadBytes) {
          settle(null, head, "request head exceeded the limit");
        }
        return;
      }
      settle(parseHostHeader(head.subarray(0, end)), head, null);
    };

    const settle = (host: string | null, head: Buffer, error: string | null) => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.setTimeout(0);
      // Pausing here is what makes the pre-read safe: any bytes that arrive between now
      // and the agent's stream being wired up stay in the socket's internal buffer.
      socket.pause();

      if (error !== null) {
        respond(socket, 431, "Request Header Fields Too Large", error);
        return;
      }
      this.route(socket, host, head);
    };

    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      settled = true;
    });
  }

  private route(socket: Socket, host: string | null, head: Buffer): void {
    if (!host) {
      respond(socket, 400, "Bad Request", "no Host header in the request");
      return;
    }

    const bare = stripPort(host).toLowerCase();
    if (!bare.endsWith(this.hostSuffix)) {
      log.debug("host outside the tunnel domain", { host: bare });
      respond(socket, 404, "Not Found", `${bare} is not a tunnel hostname`);
      return;
    }

    const subdomain = bare.slice(0, -this.hostSuffix.length);
    // Only single-label subdomains are routable; a wildcard cert covers one level anyway.
    if (!subdomain || subdomain.includes(".")) {
      respond(socket, 404, "Not Found", `${bare} is not a tunnel hostname`);
      return;
    }

    const tunnel = this.registry.lookupHttp(subdomain);
    if (!tunnel) {
      log.debug("no tunnel for subdomain", { subdomain });
      respond(
        socket,
        502,
        "Bad Gateway",
        `No device is serving ${subdomain}.${this.cfg.httpDomain} right now.`,
      );
      return;
    }

    tunnel.agent.openStream(tunnel, socket, head);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.cfg.httpPort, this.cfg.httpHost, () => {
        log.info("http frontend listening", {
          addr: `${this.cfg.httpHost}:${this.cfg.httpPort}`,
          domain: `*.${this.cfg.httpDomain}`,
        });
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function parseHostHeader(head: Buffer): string | null {
  const text = head.toString("latin1");
  for (const line of text.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === "host") {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/** Minimal hand-rolled response — we never built an http.Server to do it for us. */
function respond(socket: Socket, status: number, statusText: string, detail: string): void {
  const body =
    `<!doctype html><meta charset="utf-8"><title>${status} ${statusText}</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:20vh auto;padding:0 1.5rem;color:#222}` +
    `h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#666;margin:0}code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}</style>` +
    `<h1>${status} ${statusText}</h1><p>${escapeHtml(detail)}</p>`;

  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n` +
      body,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
