import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { webmcpSchemaPlugin } from './vite-webmcp-plugin'

// https://vite.dev/config/
// webmcpSchemaPlugin extracts each exported tool function's JSON Schema from its
// TS types + JSDoc at build time (docs/06 §1) and injects __webmcpSchema. It
// wraps webmcp-nexus-core directly to fix an upstream Windows path-separator bug
// in vite-plugin-webmcp-nexus (see vite-webmcp-plugin.ts).
export default defineConfig({
  plugins: [
    react(),
    webmcpSchemaPlugin({ include: ['src/mcp/**/*.ts'] }),
  ],
})
