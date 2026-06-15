import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@whale\//],
  // pino can't be bundled into ESM (dynamic require), so it stays external.
  external: ['pino', 'pino-pretty', '@prisma/client', '.prisma', 'ioredis', 'telegraf'],
});
