import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Detection is memoized per process, and several tests assert on that
    // memoization (identical frozen object, stable digest). One worker, no file
    // parallelism, so the memoized snapshot semantics stay observable rather
    // than being an accident of scheduling.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
