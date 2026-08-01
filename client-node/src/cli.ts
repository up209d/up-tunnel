#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Agent, AuthError, CLIENT_ID } from "./agent.js";
import {
  ConfigError,
  defaultName,
  findDefaultConfig,
  loadConfigFile,
  parseTarget,
  specsFromConfig,
  type AgentConfig,
  type TunnelSpec,
} from "./config.js";
import { log, setLevel } from "./log.js";

const VERSION = "0.1.0";

const USAGE = `uptunnel ${VERSION} — expose a local HTTP or TCP service through your own tunnel server

Usage
  uptunnel http <port|host:port> --subdomain <name> [--rewrite-host]
  uptunnel tcp  <port|host:port> [--remote-port <n>]
  uptunnel [--config up.yaml]        run every tunnel declared in the config file

Options
  -c, --config <path>   config file; up.yaml / up.yml / up.json is found automatically
      --server <url>    control URL, e.g. wss://tunnel.example.com/control
      --token <secret>  this device's shared secret
      --name <label>    label shown in server logs (default: hostname)
      --subdomain <s>   required for http; becomes <s>.tun.<your-domain>
      --remote-port <n> preferred public port for tcp; the server picks one if omitted
      --rewrite-host    rewrite Host to the local target (Vite, webpack, Angular)
      --insecure        skip TLS verification (self-signed certificates only)
  -v, --verbose         debug logging
      --version         print the version
  -h, --help            print this help

Environment
  UPTUNNEL_SERVER, UPTUNNEL_TOKEN, UPTUNNEL_NAME
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        server: { type: "string" },
        token: { type: "string" },
        name: { type: "string" },
        subdomain: { type: "string" },
        "remote-port": { type: "string" },
        "rewrite-host": { type: "boolean", default: false },
        insecure: { type: "boolean", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        version: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values: opts, positionals } = parsed;

  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (opts.verbose) setLevel("debug");

  let cfg: AgentConfig;
  try {
    cfg = await resolveConfig(opts, positionals);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      return 2;
    }
    throw err;
  }

  const agent = new Agent(cfg);
  const shutdown = () => {
    agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await agent.runForever();
  } catch (err) {
    if (err instanceof AuthError) {
      log.error(`authentication failed — ${err.message}`);
      return 1;
    }
    throw err;
  }
  return 0;
}

type Options = {
  config?: string | undefined;
  server?: string | undefined;
  token?: string | undefined;
  name?: string | undefined;
  subdomain?: string | undefined;
  "remote-port"?: string | undefined;
  "rewrite-host": boolean;
  insecure: boolean;
};

async function resolveConfig(opts: Options, positionals: string[]): Promise<AgentConfig> {
  const command = positionals[0];
  if (command !== undefined && command !== "http" && command !== "tcp") {
    throw new ConfigError(`unknown command ${JSON.stringify(command)} — expected http or tcp`);
  }

  let raw: Record<string, unknown> = {};
  const path = opts.config ?? findDefaultConfig();
  if (path) {
    raw = await loadConfigFile(path);
    log.debug(`loaded config from ${path}`);
  }

  const server = opts.server ?? process.env.UPTUNNEL_SERVER ?? asString(raw.server);
  const token = opts.token ?? process.env.UPTUNNEL_TOKEN ?? asString(raw.token);
  const name = opts.name ?? asString(raw.name) ?? defaultName();

  if (!server) {
    throw new ConfigError(
      "no server URL — pass --server, set UPTUNNEL_SERVER, or put it in the config",
    );
  }
  if (!token) {
    throw new ConfigError(
      "no token — pass --token, set UPTUNNEL_TOKEN, or put it in the config",
    );
  }

  let tunnels: TunnelSpec[];
  if (command === "http") {
    if (!opts.subdomain) throw new ConfigError("http tunnels need --subdomain");
    const [targetHost, targetPort] = parseTarget(requireTarget(positionals));
    tunnels = [
      {
        name: opts.subdomain,
        kind: "http",
        targetHost,
        targetPort,
        subdomain: opts.subdomain,
        rewriteHost: opts["rewrite-host"],
      },
    ];
  } else if (command === "tcp") {
    const [targetHost, targetPort] = parseTarget(requireTarget(positionals));
    const spec: TunnelSpec = { name: `tcp-${targetPort}`, kind: "tcp", targetHost, targetPort };
    if (opts["remote-port"]) {
      const [, port] = parseTarget(opts["remote-port"]);
      spec.remotePort = port;
    }
    tunnels = [spec];
  } else {
    tunnels = specsFromConfig(raw);
    if (tunnels.length === 0) {
      throw new ConfigError(
        "nothing to expose — declare tunnels in the config, or run " +
          "`uptunnel http <port> --subdomain <name>`",
      );
    }
  }

  return { server, token, name, tunnels, insecure: opts.insecure || raw.insecure === true };
}

function requireTarget(positionals: string[]): string {
  const target = positionals[1];
  if (!target) throw new ConfigError("missing target — e.g. `uptunnel http 3000 --subdomain web`");
  return target;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Only run when invoked as a program, so importing this file stays side-effect free.
// realpath on both sides so the npm bin symlink resolves to the same file.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log.error(String(err instanceof Error ? err.stack ?? err.message : err));
      process.exit(1);
    },
  );
}

export { CLIENT_ID, VERSION };
