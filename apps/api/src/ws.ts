import { CHANNELS, config, createRedis, logger } from '@whale/core';
import type { FastifyInstance } from 'fastify';
import { wsConnections } from './metrics.js';

const log = logger.child({ svc: 'api', mod: 'ws' });

interface Client {
  send: (data: string) => void;
  channels: Set<string>;
}

/**
 * Realtime fan-out. A single Redis subscriber relays engine pub/sub events to
 * every connected WebSocket. Clients may filter with `?channels=whales,steam`;
 * default is the firehose. Heartbeats keep proxies from idling the socket.
 */
export async function registerWebsocket(app: FastifyInstance): Promise<void> {
  const clients = new Set<Client>();
  const sub = createRedis();
  const channels = Object.values(CHANNELS);
  await sub.subscribe(...channels);

  sub.on('message', (channel, message) => {
    for (const c of clients) {
      if (c.channels.size === 0 || c.channels.has(channel)) {
        try {
          c.send(JSON.stringify({ channel, data: JSON.parse(message) }));
        } catch {
          /* client buffer closed */
        }
      }
    }
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    // Browsers can't set headers on the WS handshake, so the key rides the
    // query string. Enforced only when API_KEYS is configured.
    if (config.API_KEYS.length > 0 && !config.API_KEYS.includes(q.key ?? '')) {
      socket.close(1008, 'unauthorized');
      return;
    }
    const requested = q.channels ? q.channels.split(',').map((s) => `ww:${s.trim()}`) : [];
    const client: Client = { send: (d) => socket.send(d), channels: new Set(requested) };
    clients.add(client);
    wsConnections.inc();
    socket.send(JSON.stringify({ channel: 'system', data: { type: 'connected', channels } }));

    const heartbeat = setInterval(() => {
      try {
        socket.ping();
      } catch {
        /* noop */
      }
    }, 25_000);

    socket.on('close', () => {
      clients.delete(client);
      wsConnections.dec();
      clearInterval(heartbeat);
    });
    socket.on('error', () => {
      clients.delete(client);
      clearInterval(heartbeat);
    });
  });

  app.addHook('onClose', async () => {
    await sub.quit();
  });

  log.info({ channels }, 'websocket relay ready');
}
