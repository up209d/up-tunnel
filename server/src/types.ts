import type { Server as NetServer } from "node:net";

import type { AgentSession } from "./agent.js";

export type TunnelKind = "http" | "tcp";

export interface Tunnel {
  id: string;
  kind: TunnelKind;
  agent: AgentSession;
  /** Set for kind === "http": the label in `<subdomain>.<httpDomain>`. */
  subdomain?: string;
  /** Set for kind === "tcp": the public port the server listens on. */
  publicPort?: number;
  /** Where the *agent* will connect locally. Informational on the server. */
  target: { host: string; port: number };
  createdAt: number;
  /** Public listener for kind === "tcp", owned by the TCP frontend. */
  listener?: NetServer;
  openConns: number;
  totalConns: number;
  bytesToAgent: number;
  bytesFromAgent: number;
}

export interface OpenTunnelRequest {
  reqId?: string;
  kind: TunnelKind;
  subdomain?: string;
  remotePort?: number;
  target: { host: string; port: number };
}

export class TunnelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
