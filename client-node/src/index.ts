/**
 * Library entry point, for embedding the agent in your own Node program:
 *
 *   import { Agent } from "uptunnel-client";
 *
 *   await new Agent({
 *     server: "wss://tunnel.example.com/control",
 *     token: process.env.UPTUNNEL_TOKEN!,
 *     name: "my-service",
 *     insecure: false,
 *     tunnels: [
 *       { name: "web", kind: "http", subdomain: "app", targetHost: "127.0.0.1", targetPort: 3000 },
 *     ],
 *   }).runForever();
 */

export { Agent, AuthError, CLIENT_ID } from "./agent.js";
export { ClientStream, rewriteHostHeader } from "./stream.js";
export {
  ConfigError,
  defaultName,
  findDefaultConfig,
  loadConfigFile,
  parseTarget,
  specsFromConfig,
  targetLabel,
  type AgentConfig,
  type TunnelKind,
  type TunnelSpec,
} from "./config.js";
export { log, setColor, setLevel } from "./log.js";
export * as protocol from "./protocol.js";
