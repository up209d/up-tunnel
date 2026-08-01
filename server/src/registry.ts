import { randomBytes } from "node:crypto";

import { subdomainAllowed, type Config } from "./config.js";
import { logger } from "./log.js";
import type { AgentSession } from "./agent.js";
import { TunnelError, type OpenTunnelRequest, type Tunnel } from "./types.js";

const log = logger("registry");

/** Labels that would shadow the control plane or be confusing in URLs. */
const RESERVED_SUBDOMAINS = new Set(["www", "api", "admin", "tunnel", "control", "status"]);
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const DEFAULT_MAX_TUNNELS = 32;

export type TcpBinder = (tunnel: Tunnel) => Promise<void>;

/**
 * Single source of truth for which tunnels exist and what they are reachable at.
 *
 * Subdomains and public ports are claimed here; the actual TCP listener is created by the
 * injected binder so this module stays free of socket handling.
 */
export class Registry {
  private readonly byId = new Map<string, Tunnel>();
  private readonly bySubdomain = new Map<string, Tunnel>();
  private readonly byPort = new Map<number, Tunnel>();
  private nextPortHint: number;

  constructor(
    private readonly cfg: Config,
    private readonly bindTcp: TcpBinder,
  ) {
    this.nextPortHint = cfg.tcpPortMin;
  }

  get tunnels(): Iterable<Tunnel> {
    return this.byId.values();
  }

  get size(): number {
    return this.byId.size;
  }

  lookupHttp(subdomain: string): Tunnel | undefined {
    return this.bySubdomain.get(subdomain);
  }

  lookupPort(port: number): Tunnel | undefined {
    return this.byPort.get(port);
  }

  parseRequest(body: Record<string, unknown>): OpenTunnelRequest {
    const kind = body.kind;
    if (kind !== "http" && kind !== "tcp") {
      throw new TunnelError("bad_request", `kind must be "http" or "tcp"`);
    }

    const rawTarget = (body.target ?? {}) as Record<string, unknown>;
    const targetPort = Number(rawTarget.port);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw new TunnelError("bad_request", "target.port must be a port number");
    }
    const targetHost = typeof rawTarget.host === "string" && rawTarget.host ? rawTarget.host : "127.0.0.1";

    const req: OpenTunnelRequest = {
      kind,
      target: { host: targetHost, port: targetPort },
    };
    if (typeof body.reqId === "string") req.reqId = body.reqId;

    if (kind === "http") {
      const sub = typeof body.subdomain === "string" ? body.subdomain.toLowerCase().trim() : "";
      if (!sub) throw new TunnelError("bad_request", "http tunnels need a subdomain");
      if (!SUBDOMAIN_RE.test(sub)) {
        throw new TunnelError("bad_request", `subdomain ${JSON.stringify(sub)} is not a valid DNS label`);
      }
      if (RESERVED_SUBDOMAINS.has(sub)) {
        throw new TunnelError("subdomain_forbidden", `${sub} is reserved`);
      }
      req.subdomain = sub;
    } else if (body.remotePort !== undefined && body.remotePort !== null) {
      const port = Number(body.remotePort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new TunnelError("bad_request", "remotePort must be a port number");
      }
      req.remotePort = port;
    }

    return req;
  }

  async open(agent: AgentSession, req: OpenTunnelRequest): Promise<Tunnel> {
    const maxTunnels = agent.token.maxTunnels ?? DEFAULT_MAX_TUNNELS;
    if (agent.tunnels.size >= maxTunnels) {
      throw new TunnelError("too_many_tunnels", `this token is limited to ${maxTunnels} tunnels`);
    }

    const tunnel: Tunnel = {
      id: `tn_${randomBytes(5).toString("hex")}`,
      kind: req.kind,
      agent,
      target: req.target,
      createdAt: Date.now(),
      openConns: 0,
      totalConns: 0,
      bytesToAgent: 0,
      bytesFromAgent: 0,
    };

    if (req.kind === "http") {
      const sub = req.subdomain!;
      if (!subdomainAllowed(agent.token.subdomains, sub)) {
        throw new TunnelError("subdomain_forbidden", `token ${agent.token.name} may not claim ${sub}`);
      }
      const existing = this.bySubdomain.get(sub);
      if (existing) {
        throw new TunnelError(
          "subdomain_taken",
          `${sub} is already served by ${existing.agent.clientName}`,
        );
      }
      tunnel.subdomain = sub;
      this.bySubdomain.set(sub, tunnel);
    } else {
      const port = this.claimPort(agent, req.remotePort);
      tunnel.publicPort = port;
      this.byPort.set(port, tunnel);
      try {
        await this.bindTcp(tunnel);
      } catch (err) {
        this.byPort.delete(port);
        throw new TunnelError("port_taken", `cannot listen on ${port}: ${(err as Error).message}`);
      }
    }

    this.byId.set(tunnel.id, tunnel);
    agent.tunnels.set(tunnel.id, tunnel);
    log.info("tunnel opened", {
      id: tunnel.id,
      kind: tunnel.kind,
      at: tunnel.subdomain ?? tunnel.publicPort,
      agent: agent.clientName,
      target: `${tunnel.target.host}:${tunnel.target.port}`,
    });
    return tunnel;
  }

  private claimPort(agent: AgentSession, requested?: number): number {
    const [lo, hi] = agent.token.ports ?? [this.cfg.tcpPortMin, this.cfg.tcpPortMax];
    const min = Math.max(lo, this.cfg.tcpPortMin);
    const max = Math.min(hi, this.cfg.tcpPortMax);

    if (requested !== undefined) {
      if (requested < min || requested > max) {
        throw new TunnelError(
          "port_forbidden",
          `port ${requested} is outside the allowed range ${min}-${max}`,
        );
      }
      if (this.byPort.has(requested)) {
        throw new TunnelError("port_taken", `port ${requested} is already in use`);
      }
      return requested;
    }

    const span = max - min + 1;
    for (let i = 0; i < span; i++) {
      const port = min + ((this.nextPortHint - min + i + span) % span);
      if (!this.byPort.has(port)) {
        this.nextPortHint = port + 1 > max ? min : port + 1;
        return port;
      }
    }
    throw new TunnelError("no_ports_available", `all ports in ${min}-${max} are in use`);
  }

  close(tunnel: Tunnel): void {
    if (!this.byId.delete(tunnel.id)) return;
    if (tunnel.subdomain) this.bySubdomain.delete(tunnel.subdomain);
    if (tunnel.publicPort !== undefined) this.byPort.delete(tunnel.publicPort);
    tunnel.agent.tunnels.delete(tunnel.id);
    tunnel.listener?.close();
    tunnel.listener = undefined;
    log.info("tunnel closed", { id: tunnel.id, at: tunnel.subdomain ?? tunnel.publicPort });
  }

  closeAllFor(agent: AgentSession): void {
    for (const tunnel of [...agent.tunnels.values()]) this.close(tunnel);
  }

  publicUrl(tunnel: Tunnel): string {
    return `${this.cfg.publicScheme}://${tunnel.subdomain}.${this.cfg.httpDomain}`;
  }
}
