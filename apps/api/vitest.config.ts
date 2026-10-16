import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Every test file uses the same database schema, so run the files one after another.
    fileParallelism: false,
  },
});
