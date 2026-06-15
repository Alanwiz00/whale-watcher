import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Bundle internal workspace packages; keep native/runtime deps external.
  // pino can't be bundled into ESM (dynamic require), so it stays external.
  noExternal: [/^@whale\//],
  external: ['pino', 'pino-pretty', 'ioredis', 'bullmq', 'prom-client'],
});
