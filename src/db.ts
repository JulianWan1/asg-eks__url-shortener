// Database access + self-migration.
//
// The self-migrate is the load-bearing design choice for the whole devops-lab
// project: on startup the app runs `CREATE TABLE IF NOT EXISTS`, so a freshly
// provisioned, completely empty RDS instance works with zero manual steps.
// That is what makes `make down` / `make up` (destroy the DB nightly, recreate
// it next session) painless — there is never a migration to remember to run.
//
// For a real product you would use a proper migration tool (versioned, with a
// history table) instead of idempotent DDL on boot. For a throwaway dev stack,
// this is the right amount of machinery.

import { Pool } from "pg";
import type { Logger } from "./logger";

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    // Keep the pool small: t3.micro instances and a db.t4g.micro don't have
    // headroom for hundreds of connections, and RDS connection limits are low.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

// On a fresh `make up`, the app container often starts before RDS is accepting
// connections. Retry with backoff rather than crash-looping.
export async function waitForDb(
  pool: Pool,
  logger: Logger,
  attempts = 10,
  delayMs = 2_000,
): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      logger.info("database reachable", { attempt: i });
      return;
    } catch (err) {
      const last = i === attempts;
      logger.warn("database not ready", {
        attempt: i,
        of: attempts,
        error: (err as Error).message,
      });
      if (last) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function migrate(pool: Pool, logger: Logger): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      code        TEXT PRIMARY KEY,
      target_url  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  logger.info("schema ready");
}
