import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@whale\//],
  external: ['@prisma/client', '.prisma', 'ioredis', 'prom-client', 'fastify', '@fastify/cors', '@fastify/websocket', '@fastify/rate-limit'],
});
