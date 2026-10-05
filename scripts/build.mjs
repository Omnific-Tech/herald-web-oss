import { build } from 'esbuild'

const shared = { bundle: true, target: 'es2022', logLevel: 'warning' }

await build({ ...shared, entryPoints: ['src/index.ts', 'src/sw.ts'], outdir: 'dist', format: 'esm' })
await build({ ...shared, entryPoints: ['src/sw-classic.ts'], outfile: 'dist/herald-sw.js', format: 'iife' })
