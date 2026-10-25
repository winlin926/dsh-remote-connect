import { defineConfig } from 'vitest/config'
// The public entry is a fixed port in production; tests use their own so a running DSH
// (which may hold the real port) does not make the suite fail.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, env: { DSH_RC_PUBLIC_PORT: '45871' } } })
