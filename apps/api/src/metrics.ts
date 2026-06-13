import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

export const register = new Registry();
collectDefaultMetrics({ register });

export const httpRequests = new Counter({
  name: 'ww_api_requests_total',
  help: 'HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const wsConnections = new Gauge({
  name: 'ww_api_ws_connections',
  help: 'Open WebSocket connections',
  registers: [register],
});
