type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;
const asJson = process.env.LOG_FORMAT === "json";

const COLOR: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const time = new Date().toISOString();

  if (asJson) {
    process.stdout.write(JSON.stringify({ time, level, scope, msg, ...fields }) + "\n");
    return;
  }

  const tail = fields
    ? " " +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ")
    : "";
  const line = `${time} ${COLOR[level]}${level.toUpperCase().padEnd(5)}\x1b[0m [${scope}] ${msg}${tail}\n`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
