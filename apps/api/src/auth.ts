import { config } from '@whale/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Bearer-token guard for mutating / sensitive endpoints. Read endpoints are
 * public by default (rate-limited). If API_KEYS is empty, auth is disabled
 * (dev convenience) — set it in production.
 */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.API_KEYS.length === 0) return;
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!config.API_KEYS.includes(token)) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}
