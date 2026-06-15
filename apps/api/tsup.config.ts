import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@whale\//],
  // pino (+ its worker-thread ecosystem) can't be bundled into ESM — it uses
  // dynamic require ("Dynamic require of 'os' is not supported"). Keep it external
  // and declare it as a direct dependency so it resolves at runtime. Other deps
  // (zod, etc.) bundle fine.
  external: ['pino', 'pino-pretty', '@prisma/client', '.prisma', 'ioredis', 'prom-client', 'fastify', '@fastify/cors', '@fastify/websocket', '@fastify/rate-limit'],
});
