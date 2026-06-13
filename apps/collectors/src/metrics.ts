import { createServer } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import { logger } from '@whale/core';

const log = logger.child({ svc: 'collectors', mod: 'metrics' });

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const tradesIngested = new Counter({
  name: 'ww_trades_ingested_total',
  help: 'Normalized trades enqueued',
  labelNames: ['platform'],
  registers: [metricsRegistry],
});

export const marketsDiscovered = new Gauge({
  name: 'ww_markets_tracked',
  help: 'Tracked World Cup markets',
  labelNames: ['platform'],
  registers: [metricsRegistry],
});

export const collectErrors = new Counter({
  name: 'ww_collect_errors_total',
  help: 'Collector errors',
  labelNames: ['platform', 'stage'],
  registers: [metricsRegistry],
});

export const collectDuration = new Gauge({
  name: 'ww_collect_duration_seconds',
  help: 'Duration of a collection stage',
  labelNames: ['stage'],
  registers: [metricsRegistry],
});

/** Tiny standalone metrics endpoint for Prometheus to scrape. */
export function startMetricsServer(port: number): void {
  createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } else if (req.url === '/health') {
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end();
    }
  }).listen(port, () => log.info({ port }, 'metrics server listening'));
}
