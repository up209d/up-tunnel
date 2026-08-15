/**
 * Optional bounded health log for the agent side of the connection.
 *
 * The console log tells you what is happening while you are watching. This
 * tells you what happened at 3am: connect, handshake, every heartbeat and its
 * round trip, and how each session ended. When a device is unreachable, the
 * question is always which end gave up first — that needs both ends writing to
 * a file, not just the server.
 *
 * Off unless UPTUNNEL_HEALTH_LOG names a path; capped at
 * UPTUNNEL_HEALTH_LOG_MAX_LINES (default 1000) with the newest 80% kept on
 * trim, matching the server's health log and the Pico's tunnel.log.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "./log.js";

const KEEP_RATIO = 0.8;
const DEFAULT_MAX_LINES = 1000;

let file: string | null = null;
let maxLines = DEFAULT_MAX_LINES;
let lines = 0;
let broken = false;

function countLines(path: string): number {
  try {
    const body = readFileSync(path, "utf8");
    if (body.length === 0) return 0;
    return body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

/** Read the env and open the log. Safe to call when neither var is set. */
export function configureFromEnv(): void {
  const path = process.env.UPTUNNEL_HEALTH_LOG;
  file = path && path.length > 0 ? path : null;
  broken = false;
  const raw = Number.parseInt(process.env.UPTUNNEL_HEALTH_LOG_MAX_LINES ?? "", 10);
  maxLines = Number.isFinite(raw) && raw > 10 ? raw : DEFAULT_MAX_LINES;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    lines = countLines(file);
  } catch (err) {
    broken = true;
    log.warn(`health log unavailable (${(err as Error).message})`);
  }
}

function trim(): void {
  if (!file) return;
  const keep = Math.floor(maxLines * KEEP_RATIO);
  try {
    const all = readFileSync(file, "utf8").split("\n");
    if (all.length && all[all.length - 1] === "") all.pop();
    const tmp = `${file}.tmp`;
    // Write-then-rename so an interrupted trim cannot lose the whole log.
    writeFileSync(tmp, all.slice(-keep).join("\n") + "\n");
    renameSync(tmp, file);
    lines = Math.min(keep, all.length);
  } catch (err) {
    log.warn(`health log trim failed (${(err as Error).message})`);
    lines = countLines(file);
  }
}

/** Record one health event. Never throws — diagnostics must not kill the agent. */
export function health(msg: string, fields?: Record<string, unknown>): void {
  if (!file || broken) return;
  const tail = fields
    ? " " +
      Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ")
    : "";
  try {
    appendFileSync(file, `${new Date().toISOString()} ${msg}${tail}\n`);
  } catch (err) {
    broken = true;
    log.warn(`health log write failed, disabling (${(err as Error).message})`);
    return;
  }
  if (++lines >= maxLines) trim();
}
