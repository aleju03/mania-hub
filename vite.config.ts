import { defineConfig, type Plugin, type ServerOptions } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import { uiScalePostcss } from './scripts/ui-scale-postcss'
import { buildSupporterNamesCss } from './scripts/supporter-names-css'

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
    // the name fonts /supporter-names.css loads from other origins (Hashi);
    // the nitro routeRules below do the same in production
    if (url.startsWith('/fonts/name/')) res.setHeader('Access-Control-Allow-Origin', '*')
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

/* virtual:supporter-names-css: the list-size name styles and fonts cut from
   src/styles.css (scripts/supporter-names-css.ts), served by
   src/routes/supporter-names[.]css.ts. */
function supporterNamesCss(): Plugin {
  const id = 'virtual:supporter-names-css'
  const resolved = `\0${id}`
  const stylesPath = fileURLToPath(new URL('./src/styles.css', import.meta.url))
  return {
    name: 'supporter-names-css',
    resolveId(source) {
      return source === id ? resolved : undefined
    },
    load(loaded) {
      if (loaded !== resolved) return undefined
      this.addWatchFile(stylesPath)
      const css = buildSupporterNamesCss(readFileSync(stylesPath, 'utf8'))
      const version = createHash('sha256').update(css).digest('hex').slice(0, 10)
      return `export const css = ${JSON.stringify(css)};\nexport const version = ${JSON.stringify(version)};\n`
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

const NATIVE_IMAGE_PACKAGES = ['@resvg/resvg-js', 'sharp']

const config = defineConfig({
  server: devServerOptions(),
  css: {
    postcss: {
      // The UI Scaling setting: px lengths in the app's own CSS follow
      // --ui-scale (scripts/ui-scale-postcss.ts). Tailwind generates its
      // utilities before this runs, so they are covered too.
      plugins: [uiScalePostcss({ include: (file) => file.includes('/src/') && !file.includes('/node_modules/') })],
    },
  },
  // Dev only: the dependency pre-bundler would otherwise try to bundle resvg's
  // .node binary and stop the dev server; Node loads both packages as-is.
  // The theme editor's GLSL parser is only imported once the editor opens; found
  // that late, Vite re-bundles mid-session and the reload runs two Reacts
  // ("reading 'useContext'" of null) until a manual refresh.
  optimizeDeps: { exclude: NATIVE_IMAGE_PACKAGES, include: ["@shaderfrog/glsl-parser", "@shaderfrog/glsl-parser/preprocessor"] },
  ssr: { external: NATIVE_IMAGE_PACKAGES, optimizeDeps: { exclude: NATIVE_IMAGE_PACKAGES } },
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
    // the name fonts /supporter-names.css loads from other origins (Hashi's
    // webview and its OBS source); the dev server sets it in staticCacheHeaders
    routeRules: {
      '/fonts/name/**': { headers: { 'access-control-allow-origin': '*' } },
    },
    // The two native image packages are marked external up front and traced
    // into the server output here. Left to Nitro, resvg's CommonJS wrapper is
    // loaded by the commonjs pass before Nitro's externals get a say, which
    // then fails parsing its .node binary; sharp is bundled without its
    // binary, and only shipped before because @vercel/og pulled it in.
    unenv: [{ external: NATIVE_IMAGE_PACKAGES }],
    hooks: {
      async compiled(nitro) {
        if (nitro.options.dev) return
        const { traceNodeModules } = await import('nf3')
        // Both entries: the server imports sharp's ESM build, resvg's only
        // entry is CommonJS.
        const require = createRequire(import.meta.url)
        const entries = NATIVE_IMAGE_PACKAGES.flatMap((name) => [require.resolve(name), fileURLToPath(import.meta.resolve(name))])
        await traceNodeModules([...new Set(entries)], {
          rootDir: nitro.options.rootDir,
          outDir: nitro.options.output.serverDir,
          conditions: nitro.options.exportConditions,
        })
      },
    },
    rollupConfig: {
      onwarn: suppressDependencyBuildWarnings,
    },
  },
  plugins: [
    staticCacheHeaders(),
    supporterNamesCss(),
    localReplayVideoExport(),
    devtools(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    nitro(),
    // The lingui macro must run wherever this babel pass runs; vitest.config.ts
    // (which deliberately does not load this file) declares it too, so the two
    // lists have to move together.
    viteReact({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
  ],
})

export default config
