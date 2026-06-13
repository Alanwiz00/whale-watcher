import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@whale\//],
  // Keep Prisma + native deps external; they ship their own runtime artifacts.
  external: ['@prisma/client', '.prisma', 'ioredis', 'bullmq', 'prom-client'],
});
