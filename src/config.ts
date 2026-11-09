// All configuration comes from the environment — never from files or hardcoded
// values. This is what lets the exact same image run locally, on an EC2 in the
// ASG, and in a Kubernetes pod with nothing but different env vars.
//
// The app fails fast on bad config: if DATABASE_URL is missing, it exits at
// startup rather than limping along and failing later on the first request.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
  // How long to let in-flight requests drain on SIGTERM before forcing exit.
  shutdownTimeoutMs: number;
}

const VALID_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `See .env.example for the full list.`,
    );
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}".`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const logLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  if (!VALID_LEVELS.includes(logLevel)) {
    throw new Error(
      `LOG_LEVEL must be one of ${VALID_LEVELS.join(", ")}, got "${logLevel}".`,
    );
  }

  return {
    port: optionalInt("PORT", 3000),
    databaseUrl: required("DATABASE_URL"),
    logLevel,
    shutdownTimeoutMs: optionalInt("SHUTDOWN_TIMEOUT_MS", 10_000),
  };
}
