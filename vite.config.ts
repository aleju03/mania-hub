import { defineConfig, type Plugin, type ServerOptions } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

function staticCacheHeaders(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? ''
    if (url.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else if (
      url.startsWith('/fonts/') ||
      url.startsWith('/images/') ||
      url.startsWith('/favicon')
    ) {
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400')
    }
    next()
  }
  return {
    name: 'static-cache-headers',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

function localReplayVideoExport(): Plugin {
  return {
    name: 'local-replay-video-export',
    async configureServer(server) {
      const { replayVideoJobMiddleware } = await import('./scripts/dev/replay-video-job')
      server.middlewares.use(replayVideoJobMiddleware())
    },
  }
}

function suppressDependencyBuildWarnings(warning: any, warn: (warning: any) => void) {
  const message = String(warning.message ?? '')
  if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && message.includes('node_modules/')) return
  if (warning.code === 'UNUSED_EXTERNAL_IMPORT' && message.includes('node_modules/')) return
  if (warning.code === 'EMPTY_BUNDLE' && message.startsWith('Generated an empty chunk:')) return
  warn(warning)
}

// `scripts/dev/run-dev-stack.mjs --host` sets these so LAN devices get a secure
// context (see the comment there). The live backend is proxied through this
// same origin: an https page cannot fetch its plain-http origin, and one origin
// means one cert to trust instead of two.
function devServerOptions(): ServerOptions {
  const options: ServerOptions = { allowedHosts: ['.loca.lt'] }

  const keyPath = process.env.DEV_HTTPS_KEY
  const certPath = process.env.DEV_HTTPS_CERT
  if (keyPath && certPath) {
    options.https = { key: readFileSync(keyPath), cert: readFileSync(certPath) }
  }

  const proxyTarget = process.env.DEV_LIVE_BACKEND_PROXY
  const proxyPrefix = process.env.DEV_LIVE_BACKEND_PROXY_PREFIX
  if (proxyTarget && proxyPrefix) {
    options.proxy = {
      [proxyPrefix]: {
        target: proxyTarget,
        // Keep the browser's Host/Origin so the backend's origin allowlist and
        // its SSE endpoints see the request they would see without the proxy.
        changeOrigin: false,
        rewrite: (path) => path.slice(proxyPrefix.length) || '/',
      },
    }
  }

  return options
}

const config = defineConfig({
  server: devServerOptions(),
  build: {
    chunkSizeWarningLimit: 1500,
    // Skips the gzip-size column in build logs; run a local build with this
    // removed when actual compressed sizes are needed.
    reportCompressedSize: false,
    rollupOptions: {
      onwarn: suppressDependencyBuildWarnings,
    },
  },
  nitro: {
    // node-server everywhere except on Vercel itself, where the preset has to
    // stay 'vercel' or the build writes .output instead of .vercel/output and
    // Vercel fails looking for it. Vercel remains the rollback target for the
    // VPS migration, so it has to keep building.
    preset: process.env.VERCEL ? 'vercel' : 'node-server',
    rollupConfig: {
      onwarn: suppressDependencyBuildWarnings,
    },
  },
  plugins: [
    staticCacheHeaders(),
    localReplayVideoExport(),
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    nitro(),
    viteReact(),
  ],
})

export default config
