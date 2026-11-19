import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { readFileSync, rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
const common = { bundle: true, target: 'es2020', legalComments: 'none', logLevel: 'warning' }

await build({ ...common, entryPoints: ['src/auto.ts'], outfile: 'dist/wgo.js', format: 'iife', globalName: 'WGO', minify: true })
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.mjs', format: 'esm' })
// session recording: loaded by wgo.js (and the npm package) only when the project records sessions
await build({ ...common, entryPoints: ['src/replay/index.ts'], outfile: 'dist/wgo-replay.js', format: 'iife', minify: true })
execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' })

const raw = readFileSync('dist/wgo.js')
const gz = gzipSync(raw, { level: 9 }).length
console.log(`dist/wgo.js: ${raw.length} bytes minified, ${gz} bytes gzipped (${(gz / 1024).toFixed(2)} KB)`)
// 10 KB plus the session recording loader (the recorder itself is wgo-replay.js, loaded only when needed)
if (gz > 11.5 * 1024) { console.error('Over the 11.5 KB gzip budget'); process.exit(1) }
const rp = readFileSync('dist/wgo-replay.js')
console.log(`dist/wgo-replay.js: ${rp.length} bytes minified, ${gzipSync(rp, { level: 9 }).length} bytes gzipped`)
