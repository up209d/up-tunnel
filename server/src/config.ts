import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TokenEntry {
  /** Shared secret the agent presents in HELLO. */
  token: string;
  /** Human label, used in logs and /status. */
  name: string;
  /**
   * Subdomain patterns this token may claim. `*` matches any single label,
   * `dev-*` matches a prefix. Omit or use ["*"] to allow anything free.
   */
  subdomains?: string[];
  /** Inclusive public TCP port range this token may claim. Defaults to the server range. */
  ports?: [number, number];
  /** Cap on simultaneous tunnels for this token. */
  maxTunnels?: number;
}

export interface Config {
  controlPort: number;
  controlHost: string;
  controlPath: string;

  httpPort: number;
  httpHost: string;
  /** Base domain for HTTP tunnels; `foo.<httpDomain>` routes to the `foo` tunnel. */
  httpDomain: string;
  publicScheme: "http" | "https";
  /** Host:port advertised to agents for TCP tunnels (what users dial). */
  publicTcpHost: string;

  tcpBindHost: string;
  tcpPortMin: number;
  tcpPortMax: number;

  adminPort: number;
  adminHost: string;
  adminToken: string | null;

  /** Initial per-stream, per-direction credit in bytes. */
  streamWindow: number;
  /** Pause every stream on an agent once its socket has this many bytes queued. */
  wsMaxBuffered: number;
  heartbeatMs: number;
  /**
   * Consecutive unanswered pings tolerated before an agent is terminated.
   * 1 was too strict: a single dropped pong on an otherwise healthy device
   * freed its subdomain and turned every request into a 502.
   */
  heartbeatMisses: number;
  /** Cap on bytes buffered while peeking for the HTTP Host header. */
  maxHttpHeadBytes: number;

  /**
   * Bounded file recording heartbeat/session events. Null disables it.
   * A relative path resolves against the process working directory.
   */
  healthLogFile: string | null;
  healthLogMaxLines: number;

  tokens: TokenEntry[];
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function envStr(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? fallback : raw;
}

function loadTokens(): TokenEntry[] {
  const file = process.env.TOKENS_FILE;
  const inline = process.env.AUTH_TOKENS;

  const entries: TokenEntry[] = [];

  if (file) {
    const path = resolve(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`cannot read TOKENS_FILE ${path}: ${(err as Error).message}`);
    }
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { tokens?: unknown })?.tokens;
    if (!Array.isArray(list)) {
      throw new Error(`${path} must be a JSON array or an object with a "tokens" array`);
    }
    for (const [i, raw] of list.entries()) {
      const e = raw as TokenEntry;
      if (!e || typeof e.token !== "string" || e.token.length < 16) {
        throw new Error(`${path}: tokens[${i}].token must be a string of at least 16 characters`);
      }
      entries.push({
        token: e.token,
        name: typeof e.name === "string" && e.name ? e.name : `token-${i}`,
        subdomains: Array.isArray(e.subdomains) ? e.subdomains : undefined,
        ports: Array.isArray(e.ports) && e.ports.length === 2 ? [e.ports[0]!, e.ports[1]!] : undefined,
        maxTunnels: typeof e.maxTunnels === "number" ? e.maxTunnels : undefined,
      });
    }
  }

  // AUTH_TOKENS=name:secret,other:secret2 — convenient for a single-box setup.
  if (inline) {
    for (const pair of inline.split(",").map((s) => s.trim()).filter(Boolean)) {
      const idx = pair.indexOf(":");
      if (idx <= 0) throw new Error(`AUTH_TOKENS entries must look like name:secret, got ${JSON.stringify(pair)}`);
      entries.push({ name: pair.slice(0, idx), token: pair.slice(idx + 1) });
    }
  }

  if (entries.length === 0) {
    throw new Error("no agent credentials configured — set TOKENS_FILE or AUTH_TOKENS");
  }

  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.token)) throw new Error(`duplicate token for ${e.name}`);
    seen.add(e.token);
  }
  return entries;
}

export function loadConfig(): Config {
  const httpDomain = envStr("HTTP_DOMAIN", "tun.localhost").toLowerCase().replace(/^\.+/, "");
  const tcpPortMin = envInt("TCP_PORT_MIN", 20000);
  const tcpPortMax = envInt("TCP_PORT_MAX", 20099);
  if (tcpPortMax < tcpPortMin) throw new Error("TCP_PORT_MAX must be >= TCP_PORT_MIN");

  const scheme = envStr("PUBLIC_SCHEME", "https");
  if (scheme !== "http" && scheme !== "https") throw new Error("PUBLIC_SCHEME must be http or https");

  return {
    controlPort: envInt("CONTROL_PORT", 8081),
    controlHost: envStr("CONTROL_HOST", "127.0.0.1"),
    controlPath: envStr("CONTROL_PATH", "/control"),

    httpPort: envInt("HTTP_PORT", 8080),
    httpHost: envStr("HTTP_HOST", "127.0.0.1"),
    httpDomain,
    publicScheme: scheme,
    publicTcpHost: envStr("PUBLIC_TCP_HOST", httpDomain),

    tcpBindHost: envStr("TCP_BIND_HOST", "0.0.0.0"),
    tcpPortMin,
    tcpPortMax,

    adminPort: envInt("ADMIN_PORT", 8082),
    adminHost: envStr("ADMIN_HOST", "127.0.0.1"),
    adminToken: process.env.ADMIN_TOKEN || null,

    streamWindow: envInt("STREAM_WINDOW", 256 * 1024),
    wsMaxBuffered: envInt("WS_MAX_BUFFERED", 8 * 1024 * 1024),
    heartbeatMs: envInt("HEARTBEAT_MS", 30_000),
    heartbeatMisses: envInt("HEARTBEAT_MISSES", 2),
    maxHttpHeadBytes: envInt("MAX_HTTP_HEAD_BYTES", 32 * 1024),

    // Relative to the working directory by default. An absolute /var/log path
    // needs root to create and a ReadWritePaths grant under systemd, which is a
    // lot of friction for `npm run dev`; deployments set the absolute path
    // explicitly in the env file.
    healthLogFile: envStr("HEALTH_LOG_FILE", "health.log") || null,
    healthLogMaxLines: envInt("HEALTH_LOG_MAX_LINES", 10_000),

    tokens: loadTokens(),
  };
}

/** `*` matches one label; a trailing `*` matches a prefix. */
export function subdomainAllowed(patterns: string[] | undefined, subdomain: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith("*")) return subdomain.startsWith(p.slice(0, -1));
    return p === subdomain;
  });
}
