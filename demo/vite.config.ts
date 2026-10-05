import { copyFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_')
  if (command === 'build' && (!env.VITE_HERALD_URL || !env.VITE_HERALD_APPLICATION)) {
    throw new Error('VITE_HERALD_URL and VITE_HERALD_APPLICATION are required to build the demo.')
  }
  return {
    plugins: [
      {
        name: 'herald-sw',
        // The demo loads the published worker build, as a product would.
        buildStart() {
          copyFileSync(new URL('../dist/herald-sw.js', import.meta.url), new URL('public/herald-sw.js', import.meta.url))
        },
      },
    ],
  }
})
