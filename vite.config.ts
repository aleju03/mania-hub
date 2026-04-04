import { defineConfig, type Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

function staticCacheHeaders(): Plugin {
  const middleware: import('connect').NextHandleFunction = (req, res, next) => {
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

const config = defineConfig({
  plugins: [
    staticCacheHeaders(),
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    nitro(),
    viteReact(),
  ],
})

export default config
