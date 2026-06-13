import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config } from '@whale/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { httpRequests } from './metrics.js';
import { dataRoutes } from './routes/data.js';
import { healthRoutes } from './routes/health.js';
import { registerWebsocket } from './ws.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: config.isProd
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin: config.API_CORS_ORIGIN === '*' ? true : config.API_CORS_ORIGIN.split(','),
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health' || req.url === '/metrics',
  });
  await app.register(websocket, { options: { maxPayload: 1_048_576 } });

  // Per-request Prometheus counter.
  app.addHook('onResponse', async (req, reply) => {
    httpRequests.inc({
      method: req.method,
      route: (req.routeOptions?.url ?? req.url).split('?')[0]!,
      status: String(reply.statusCode),
    });
  });

  await app.register(healthRoutes);
  await app.register(dataRoutes);
  await registerWebsocket(app);

  return app;
}
