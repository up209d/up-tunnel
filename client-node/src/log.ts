/** Log format deliberately matches the Python agent, so the docs describe both. */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LABEL: Record<Level, string> = { debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" };
const COLOR: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

let threshold = ORDER.info;
let colorize = process.stdout.isTTY === true;

export function setLevel(level: Level): void {
  threshold = ORDER[level];
}

export function setColor(on: boolean): void {
  colorize = on;
}

function clock(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function emit(level: Level, message: string): void {
  if (ORDER[level] < threshold) return;
  const tag = colorize ? `${COLOR[level]}${LABEL[level]}\x1b[0m` : LABEL[level];
  const line = `${clock()} ${tag} ${message}\n`;
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(line);
}

export const log = {
  debug: (m: string) => emit("debug", m),
  info: (m: string) => emit("info", m),
  warn: (m: string) => emit("warn", m),
  error: (m: string) => emit("error", m),
};
