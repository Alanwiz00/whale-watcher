import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@whale\//],
  // Keep Prisma + native/dynamic-require deps external; they ship their own
  // runtime artifacts. pino can't be bundled into ESM (dynamic require).
  external: ['pino', 'pino-pretty', '@prisma/client', '.prisma', 'ioredis', 'bullmq', 'prom-client'],
});
