import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type TunnelKind = "http" | "tcp";

export interface TunnelSpec {
  name: string;
  kind: TunnelKind;
  targetHost: string;
  targetPort: number;
  subdomain?: string;
  remotePort?: number;
  /**
   * Rewrite the Host header on the way to the local service. Vite, webpack-dev-server and
   * Angular reject requests whose Host they don't recognise.
   */
  rewriteHost?: boolean;
}

export interface AgentConfig {
  server: string;
  token: string;
  name: string;
  tunnels: TunnelSpec[];
  insecure: boolean;
  /**
   * Keepalive ping period in milliseconds. 0 disables our own ping and leaves
   * liveness entirely to the server's. Omitted means DEFAULT_PING_INTERVAL_MS.
   */
  pingIntervalMs?: number;
  /**
   * How long a ping may go unanswered before the socket is torn down and
   * reconnected. 0 pings without ever giving up on the answer. Omitted means
   * DEFAULT_PING_TIMEOUT_MS.
   */
  pingTimeoutMs?: number;
}

export class ConfigError extends Error {}

/**
 * Ping often enough that NAT mappings and proxy read timeouts never expire, and
 * give up on a silent link within one further interval. Both are per-device
 * decisions — an LTE modem or a sleepy laptop wants different numbers from a
 * box on wired ethernet — so the environment overrides them.
 */
export const DEFAULT_PING_INTERVAL_MS = 20_000;
export const DEFAULT_PING_TIMEOUT_MS = 20_000;

/** Reads UPTUNNEL_PING_INTERVAL / UPTUNNEL_PING_TIMEOUT, both in seconds. */
export function pingFromEnv(env: NodeJS.ProcessEnv = process.env): {
  pingIntervalMs: number;
  pingTimeoutMs: number;
} {
  return {
    pingIntervalMs: seconds(env, "UPTUNNEL_PING_INTERVAL", DEFAULT_PING_INTERVAL_MS),
    pingTimeoutMs: seconds(env, "UPTUNNEL_PING_TIMEOUT", DEFAULT_PING_TIMEOUT_MS),
  };
}

function seconds(env: NodeJS.ProcessEnv, name: string, fallbackMs: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative number of seconds, got ${JSON.stringify(raw)}`);
  }
  return Math.round(value * 1000);
}

export function targetLabel(spec: TunnelSpec): string {
  return `${spec.targetHost}:${spec.targetPort}`;
}

/** Accepts `3000`, `localhost:3000`, or `[::1]:3000`. */
export function parseTarget(value: string | number, defaultHost = "127.0.0.1"): [string, number] {
  const text = String(value).trim();

  if (/^\d+$/.test(text)) return [defaultHost, requirePort(text)];

  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1 || text[close + 1] !== ":") {
      throw new ConfigError(`target ${JSON.stringify(text)} is not a valid [ipv6]:port`);
    }
    return [text.slice(1, close), requirePort(text.slice(close + 2))];
  }

  const colon = text.lastIndexOf(":");
  if (colon === -1) throw new ConfigError(`target ${JSON.stringify(text)} must include a port`);
  return [text.slice(0, colon) || defaultHost, requirePort(text.slice(colon + 1))];
}

function requirePort(text: string): number {
  const port = Number.parseInt(text, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${JSON.stringify(text)} is not a port number`);
  }
  return port;
}

const DEFAULT_CONFIG_NAMES = ["up.yaml", "up.yml", "up.json"];

export function findDefaultConfig(): string | null {
  for (const name of DEFAULT_CONFIG_NAMES) {
    try {
      readFileSync(name);
      return name;
    } catch {
      /* not there, try the next */
    }
  }
  return null;
}

export async function loadConfigFile(path: string): Promise<Record<string, unknown>> {
  const full = resolve(path);
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${full}: ${(err as Error).message}`);
  }

  let data: unknown;
  if (/\.ya?ml$/i.test(full)) {
    // YAML support is optional so the common case has one dependency, not two.
    let parse: (input: string) => unknown;
    try {
      ({ parse } = await import("yaml"));
    } catch {
      throw new ConfigError(
        `${full} is YAML but the "yaml" package is not installed. ` +
          `Run \`npm install yaml\`, or use a .json config.`,
      );
    }
    data = parse(text);
  } else {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`${full} is not valid JSON: ${(err as Error).message}`);
    }
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError(`${full} must contain an object at the top level`);
  }
  return data as Record<string, unknown>;
}

export function specsFromConfig(raw: Record<string, unknown>): TunnelSpec[] {
  const list = raw.tunnels;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ConfigError(`"tunnels" must be an array`);

  return list.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigError(`tunnels[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;

    const kind = (e.kind ?? "http") as TunnelKind;
    if (kind !== "http" && kind !== "tcp") {
      throw new ConfigError(`tunnels[${i}].kind must be "http" or "tcp"`);
    }
    if (e.target === undefined) throw new ConfigError(`tunnels[${i}] needs a target`);

    const [targetHost, targetPort] = parseTarget(e.target as string | number);
    const subdomain = typeof e.subdomain === "string" ? e.subdomain : undefined;
    const name = String(e.name ?? subdomain ?? `${kind}-${i}`);

    if (kind === "http" && !subdomain) {
      throw new ConfigError(`tunnels[${i}] (${name}) needs a subdomain`);
    }

    const spec: TunnelSpec = { name, kind, targetHost, targetPort };
    if (subdomain) spec.subdomain = subdomain;
    // Accept both spellings; the Python client and YAML examples use snake_case.
    const remote = e.remote_port ?? e.remotePort;
    if (remote !== undefined && remote !== null && Number(remote) !== 0) {
      spec.remotePort = requirePort(String(remote));
    }
    if (e.rewrite_host ?? e.rewriteHost) spec.rewriteHost = true;
    return spec;
  });
}

export function defaultName(): string {
  return process.env.UPTUNNEL_NAME || hostname();
}
