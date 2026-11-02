import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/live/**/*.test.js'], environment: 'node', testTimeout: 30000 } });
