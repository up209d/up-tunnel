import { createServer } from "node:net";

import type { Config } from "./config.js";
import { logger } from "./log.js";
import type { Tunnel } from "./types.js";

const log = logger("tcp");

/**
 * Public TCP entry points. Each `kind: "tcp"` tunnel gets its own listener on a port from
 * the configured range, created on demand and torn down with the tunnel.
 *
 * The listener is stored on the tunnel so the registry can close it without knowing
 * anything about sockets.
 */
export class TcpFrontend {
  constructor(private readonly cfg: Config) {}

  bind(tunnel: Tunnel): Promise<void> {
    const port = tunnel.publicPort!;

    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        if (tunnel.agent.isClosed) {
          socket.destroy();
          return;
        }
        socket.pause();
        tunnel.agent.openStream(tunnel, socket);
      });

      server.on("error", (err) => {
        // After a successful listen this is an accept-time error, not a bind failure.
        log.error("tcp listener error", { port, err: err.message });
      });

      server.once("error", reject);
      server.listen(port, this.cfg.tcpBindHost, () => {
        server.removeListener("error", reject);
        tunnel.listener = server;
        log.info("tcp tunnel listening", {
          addr: `${this.cfg.tcpBindHost}:${port}`,
          tunnel: tunnel.id,
          target: `${tunnel.target.host}:${tunnel.target.port}`,
        });
        resolve();
      });
    });
  }
}
