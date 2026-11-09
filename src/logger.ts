// Logs go to stdout as one JSON object per line. That's the 12-factor rule:
// the app never manages log files or rotation — it emits an event stream and
// the platform (CloudWatch Logs, or `kubectl logs`) captures it. Structured
// JSON means you can filter and query later instead of grepping prose.

import type { LogLevel } from "./config";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];

  function emit(lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (ORDER[lvl] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...meta,
    };
    // Single write to stdout; the platform handles the rest.
    process.stdout.write(JSON.stringify(line) + "\n");
  }

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
