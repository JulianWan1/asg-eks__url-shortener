import express, { type Request, type Response, type NextFunction } from "express";
import type { Pool } from "pg";
import type { Logger } from "./logger";
import { generateCode } from "./shortcode";
import { httpDuration, registry } from "./metrics";

// Shared, mutable state the server flips during shutdown. Once this is true,
// /readyz reports "not ready" so the load balancer / kube stop sending new
// traffic while in-flight requests drain. Liveness (/healthz) stays green —
// the process is alive and shutting down cleanly, not broken.
export interface AppState {
  shuttingDown: boolean;
}

export function createApp(pool: Pool, logger: Logger, state: AppState) {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  // --- metrics middleware: time every request, label by matched route ------
  app.use((req: Request, res: Response, next: NextFunction) => {
    const end = httpDuration.startTimer();
    res.on("finish", () => {
      // req.route is only populated once a route matches; fall back to a fixed
      // label so unmatched paths (404s) don't explode cardinality.
      const route = req.route?.path
        ? (req.baseUrl || "") + req.route.path
        : "unmatched";
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  });

  // --- POST /shorten -------------------------------------------------------
  // The DB write path. Takes { "url": "https://..." }, stores it under a new
  // random code, returns the code. Retries on the (extremely rare) code
  // collision rather than pretending it can't happen.
  app.post("/shorten", async (req: Request, res: Response) => {
    const target = req.body?.url;
    if (typeof target !== "string" || target.trim() === "") {
      return res.status(400).json({ error: "body must include a non-empty 'url' string" });
    }
    try {
      // Reject anything that isn't a valid absolute http(s) URL.
      const parsed = new URL(target);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return res.status(400).json({ error: "url must be http or https" });
      }
    } catch {
      return res.status(400).json({ error: "url is not valid" });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        await pool.query(
          "INSERT INTO urls (code, target_url) VALUES ($1, $2)",
          [code, target],
        );
        return res.status(201).json({ code });
      } catch (err) {
        // 23505 = unique_violation → code already taken, try another.
        if ((err as { code?: string }).code === "23505") continue;
        logger.error("insert failed", { error: (err as Error).message });
        return res.status(500).json({ error: "internal error" });
      }
    }
    return res.status(500).json({ error: "could not allocate a unique code" });
  });

  // --- GET /healthz : LIVENESS --------------------------------------------
  // "Is the process alive?" — deliberately does NO database work. A brief RDS
  // blip must not cause the orchestrator to kill an otherwise-healthy process.
  // Also stays green during graceful shutdown: the process is fine, it's just
  // draining.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // --- GET /readyz : READINESS --------------------------------------------
  // "Can this instance serve traffic right now?" — actually checks the DB, and
  // reports not-ready during shutdown. The ALB target group and Kubernetes use
  // THIS (not /healthz) to decide whether to route requests here. The
  // liveness/readiness split is the whole point.
  app.get("/readyz", async (_req: Request, res: Response) => {
    if (state.shuttingDown) {
      return res.status(503).json({ status: "shutting_down" });
    }
    try {
      await pool.query("SELECT 1");
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "db_unavailable" });
    }
  });

  // --- GET /work?ms=500 : deliberate CPU burn -----------------------------
  // Your autoscaling trigger. Busy-loops for `ms` milliseconds to drive CPU up
  // on command, so you can watch the ASG scale 2 → 3 (and later the HPA react)
  // on purpose instead of hoping.
  //
  // TRADEOFF, on purpose: Node is single-threaded, so this synchronous loop
  // blocks the event loop for its duration. Under a heavy load test that can
  // make /readyz slow to respond, which itself teaches you why health-check
  // timeouts need tuning. If you want CPU to spike WITHOUT blocking liveness,
  // move this into a worker_thread — a good, self-contained exercise once the
  // basics work. Left synchronous here so the scaffold is simple and correct.
  app.get("/work", (req: Request, res: Response) => {
    const raw = Number.parseInt(String(req.query.ms ?? "250"), 10);
    if (Number.isNaN(raw) || raw < 0) {
      return res.status(400).json({ error: "ms must be a non-negative integer" });
    }
    // Cap it so a stray request can't peg a core for minutes.
    const ms = Math.min(raw, 10_000);
    const start = Date.now();
    let iterations = 0;
    while (Date.now() - start < ms) {
      Math.sqrt(Math.random()); // pure CPU work, no allocation growth
      iterations++;
    }
    res.status(200).json({ burnedMs: Date.now() - start, iterations });
  });

  // --- GET /metrics -------------------------------------------------------
  app.get("/metrics", async (_req: Request, res: Response) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  // --- GET /:code : the redirect ------------------------------------------
  // Registered last so it doesn't shadow the fixed routes above. Visible,
  // demoable behaviour: hit a short code, get 302'd to the original URL.
  app.get("/:code", async (req: Request, res: Response) => {
    const { code } = req.params;
    try {
      const result = await pool.query(
        "SELECT target_url FROM urls WHERE code = $1",
        [code],
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "not found" });
      }
      res.redirect(302, result.rows[0].target_url);
    } catch (err) {
      logger.error("lookup failed", { error: (err as Error).message });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
