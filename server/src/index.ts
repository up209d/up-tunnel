import { AdminServer } from "./admin.js";
import { loadConfig } from "./config.js";
import { ControlPlane } from "./control.js";
import { HttpFrontend } from "./http-frontend.js";
import { logger } from "./log.js";
import { Registry } from "./registry.js";
import { TcpFrontend } from "./tcp-frontend.js";

const log = logger("main");

async function main(): Promise<void> {
  const cfg = loadConfig();

  const tcp = new TcpFrontend(cfg);
  const registry = new Registry(cfg, (tunnel) => tcp.bind(tunnel));
  const control = new ControlPlane(cfg, registry);
  const http = new HttpFrontend(cfg, registry);
  const admin = new AdminServer(cfg, control, registry);

  await control.listen();
  await http.listen();
  await admin.listen();

  log.info("uptunnel server ready", {
    tokens: cfg.tokens.length,
    httpDomain: cfg.httpDomain,
    streamWindowKb: Math.round(cfg.streamWindow / 1024),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    await Promise.all([control.close(), http.close(), admin.close()]);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
