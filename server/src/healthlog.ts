/**
 * Append-only health log with a hard line ceiling.
 *
 * Separate from log.ts on purpose. That one writes to stdout and lets
 * journald/PM2 own retention, which is right for general server chatter but
 * useless for the question this file exists to answer: "the device says it was
 * connected and the public URL 502'd — which end gave up, and when?" That needs
 * a bounded, self-contained file you can read after the fact without a
 * journalctl incantation, and it needs to survive on a box where nobody set up
 * log rotation.
 *
 * Line-capped rather than size-capped so the ceiling means the same thing as
 * the agents' own logs (see client-node/src/healthlog.ts and the Pico's
 * server/tunnel_log.py, which uses this same keep-newest-80% trim).
 */

import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { logger } from "./log.js";

const log = logger("healthlog");

/** A trim leaves this fraction of maxLines, so the rewrite is amortised. */
const KEEP_RATIO = 0.8;

let file: string | null = null;
let maxLines = 10_000;
let lines = 0;
/** Set after a write failure so a bad path is reported once, not every line. */
let broken = false;

export function configure(path: string | null, max: number): void {
  file = path && path.length > 0 ? path : null;
  maxLines = max > 10 ? max : 10;
  broken = false;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    lines = countLines(file);
    log.info("health log ready", { file, maxLines, existingLines: lines });
  } catch (err) {
    broken = true;
    log.warn("health log unavailable", { file, err: (err as Error).message });
  }
}

function countLines(path: string): number {
  try {
    const body = readFileSync(path, "utf8");
    if (body.length === 0) return 0;
    // A trailing newline does not start a line, hence the -1 when present.
    return body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
  } catch {
    return 0; // no file yet, which counts as empty
  }
}

function trim(): void {
  if (!file) return;
  const keep = Math.floor(maxLines * KEEP_RATIO);
  try {
    const body = readFileSync(file, "utf8");
    const all = body.split("\n");
    if (all.length && all[all.length - 1] === "") all.pop();
    const kept = all.slice(-keep);
    // Write-then-rename, so a crash mid-trim leaves the previous good file
    // rather than a half-written one.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.join("\n") + "\n");
    renameSync(tmp, file);
    lines = kept.length;
  } catch (err) {
    log.warn("health log trim failed", { file, err: (err as Error).message });
    lines = countLines(file);
  }
}

/**
 * Record one health event. Never throws: this is diagnostics, and a full disk
 * must not take the relay down with it.
 */
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
    log.warn("health log write failed, disabling", { file, err: (err as Error).message });
    return;
  }
  if (++lines >= maxLines) trim();
}
