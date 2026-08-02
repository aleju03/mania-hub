import { defineConfig, type Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'
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

const config = defineConfig({
  server: {
    allowedHosts: ['.loca.lt'],
  },
  build: {
    chunkSizeWarningLimit: 1500,
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
