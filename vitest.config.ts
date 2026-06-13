import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts'],
    // Safe defaults so importing modules that touch @whale/core config don't
    // hard-exit during unit tests (no real DB/Redis connections are opened).
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test?schema=public',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      LOG_LEVEL: 'error',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/**/src/**', 'apps/**/src/**'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
    },
  },
});
