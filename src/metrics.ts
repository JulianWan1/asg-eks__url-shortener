// Prometheus metrics. Ignore this until the Kubernetes step of the project —
// it's wired up now so it's one less thing to add later, but nothing depends
// on it for the ASG phase.
//
// Two things are exposed at GET /metrics:
//   - default process metrics (event-loop lag, heap, GC, CPU) via prom-client
//   - a per-request histogram labelled by method / route / status
//
// Note the route label uses the *matched route pattern* (e.g. "/:code"), never
// the concrete path (e.g. "/abc1234"). Labelling by concrete path would create
// unbounded label cardinality — a classic Prometheus footgun that will blow up
// memory in a real cluster.

import { collectDefaultMetrics, Histogram, Registry } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
