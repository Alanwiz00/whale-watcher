import { prisma } from '@whale/db';
import type { FastifyInstance } from 'fastify';
import { register } from '../metrics.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  app.get('/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', register.contentType);
    return register.metrics();
  });
}
