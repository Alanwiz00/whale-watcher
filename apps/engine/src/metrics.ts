import { createServer } from 'node:http';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { logger } from '@whale/core';

const log = logger.child({ svc: 'engine', mod: 'metrics' });

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const tradesProcessed = new Counter({
  name: 'ww_engine_trades_processed_total',
  help: 'Trades processed by the engine',
  labelNames: ['platform'],
  registers: [registry],
});

export const whalesDetected = new Counter({
  name: 'ww_whales_detected_total',
  help: 'Whale signals generated',
  labelNames: ['platform', 'tier'],
  registers: [registry],
});

export const alertsEmitted = new Counter({
  name: 'ww_alerts_emitted_total',
  help: 'Alerts emitted',
  labelNames: ['type', 'severity'],
  registers: [registry],
});

export const jobLatency = new Histogram({
  name: 'ww_engine_job_seconds',
  help: 'Engine job processing latency',
  labelNames: ['queue'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export function startMetricsServer(port: number): void {
  createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', registry.contentType);
      res.end(await registry.metrics());
    } else if (req.url === '/health') {
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end();
    }
  }).listen(port, () => log.info({ port }, 'metrics server listening'));
}
