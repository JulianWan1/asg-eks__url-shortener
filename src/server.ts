// Bootstrap and lifecycle. This file is where the "cloud-native" behaviours
// that the platform depends on actually live:
//   1. fail fast on bad config
//   2. wait for the DB, then self-migrate
//   3. start listening
//   4. shut down GRACEFULLY on SIGTERM — the single most important behaviour
//      for zero-downtime rolling deploys.
//
// Why SIGTERM matters: when the ASG replaces an instance or Kubernetes rolls a
// deployment, it sends SIGTERM and waits a grace period before SIGKILL. If the
// process ignores SIGTERM, in-flight requests get cut mid-flight and users see
// errors during every deploy. The handler below flips readiness off (so no NEW
// traffic arrives), stops accepting connections, lets in-flight requests
// finish, closes the DB pool, and exits — with a hard timeout as a backstop.

import type { Server } from "node:http";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { createPool, migrate, waitForDb } from "./db";
import { createApp, type AppState } from "./app";

async function main(): Promise<void> {
  const config = loadConfig(); // throws → process exits non-zero. Fail fast.
  const logger = createLogger(config.logLevel);
  logger.info("starting", { port: config.port, logLevel: config.logLevel });

  const pool = createPool(config.databaseUrl);
  await waitForDb(pool, logger);
  await migrate(pool, logger);

  const state: AppState = { shuttingDown: false };
  const app = createApp(pool, logger, state);

  const server: Server = app.listen(config.port, () => {
    logger.info("listening", { port: config.port });
  });

  // --- graceful shutdown ---------------------------------------------------
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return; // ignore a second signal
    shuttingDown = true;
    state.shuttingDown = true; // /readyz now returns 503 → LB stops new traffic
    logger.info("shutdown signal received", { signal });

    // Backstop: if draining hangs, force exit rather than wait for SIGKILL.
    const forceTimer = setTimeout(() => {
      logger.error("drain timed out, forcing exit", {
        timeoutMs: config.shutdownTimeoutMs,
      });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceTimer.unref();

    // Stop accepting new connections; the callback fires once all in-flight
    // requests have completed.
    server.close(async () => {
      logger.info("http server closed, closing db pool");
      try {
        await pool.end();
      } catch (err) {
        logger.warn("error closing pool", { error: (err as Error).message });
      }
      logger.info("shutdown complete");
      clearTimeout(forceTimer);
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM")); // orchestrators
  process.on("SIGINT", () => void shutdown("SIGINT")); // Ctrl-C locally

  // Never leave the process in a half-dead state on an unexpected error.
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("unhandled rejection", { reason: String(reason) });
  });
}

main().catch((err) => {
  // Startup failed (bad config, DB unreachable after retries, etc.). Log and
  // exit non-zero so the orchestrator knows the start didn't take.
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "fatal startup error",
      error: (err as Error).message,
    }) + "\n",
  );
  process.exit(1);
});
