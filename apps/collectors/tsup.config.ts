import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Bundle internal workspace packages; keep native/runtime deps external.
  noExternal: [/^@whale\//],
  external: ['ioredis', 'bullmq', 'prom-client'],
});
