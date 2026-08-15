import { createServer, type Server } from "node:http";

import type { Config } from "./config.js";
import type { ControlPlane } from "./control.js";
import { logger } from "./log.js";
import type { Registry } from "./registry.js";

const log = logger("admin");

/**
 * Small operator API. Binds to localhost by default — put it behind nginx with auth if you
 * want it reachable, and set ADMIN_TOKEN.
 */
export class AdminServer {
  private readonly server: Server;

  constructor(
    private readonly cfg: Config,
    private readonly control: ControlPlane,
    private readonly registry: Registry,
  ) {
    this.server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];

      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
        return;
      }

      if (this.cfg.adminToken) {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${this.cfg.adminToken}`) {
          res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized\n");
          return;
        }
      }

      if (path === "/status") {
        const body = JSON.stringify(this.snapshot(), null, 2);
        res.writeHead(200, { "content-type": "application/json" }).end(body + "\n");
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    });
  }

  private snapshot() {
    const now = Date.now();
    return {
      now: new Date(now).toISOString(),
      uptimeSec: Math.round(process.uptime()),
      httpDomain: this.cfg.httpDomain,
      tcpPortRange: [this.cfg.tcpPortMin, this.cfg.tcpPortMax],
      agents: [...this.control.agents].map((agent) => ({
        agentId: agent.id,
        name: agent.clientName,
        token: agent.token.name,
        client: agent.clientVersion,
        remoteAddr: agent.remoteAddr,
        // Where to reach this device on its own network, as the device reports
        // it. The answer to "my Pico is headless, what IP did DHCP give it?"
        lanIp: agent.lanIp,
        lanPort: agent.lanPort,
        connectedSec: Math.round((now - agent.connectedAt) / 1000),
        openStreams: agent.streamCount,
        tunnels: agent.tunnels.size,
      })),
      tunnels: [...this.registry.tunnels].map((t) => ({
        tunnelId: t.id,
        kind: t.kind,
        public:
          t.kind === "http"
            ? this.registry.publicUrl(t)
            : `${this.cfg.publicTcpHost}:${t.publicPort}`,
        target: `${t.target.host}:${t.target.port}`,
        agent: t.agent.clientName,
        ageSec: Math.round((now - t.createdAt) / 1000),
        openConns: t.openConns,
        totalConns: t.totalConns,
        bytesToAgent: t.bytesToAgent,
        bytesFromAgent: t.bytesFromAgent,
      })),
    };
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.cfg.adminPort, this.cfg.adminHost, () => {
        log.info("admin api listening", {
          addr: `${this.cfg.adminHost}:${this.cfg.adminPort}`,
          auth: this.cfg.adminToken ? "bearer" : "none",
        });
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
