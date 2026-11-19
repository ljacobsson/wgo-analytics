import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import { findMaps, parseArgs } from '../bin/wgo-sourcemaps.mjs'

describe('wgo-sourcemaps', () => {
  it('parses flags, env and paths', () => {
    expect(parseArgs(['--endpoint', 'https://w.test/', '--key=uk_1', '--release', 'v1', 'dist/'], {})).toMatchObject({
      endpoint: 'https://w.test', key: 'uk_1', release: 'v1', paths: ['dist/'],
    })
    expect(parseArgs(['dist'], { WGO_ENDPOINT: 'https://e.test', WGO_UPLOAD_KEY: 'uk_e', WGO_RELEASE: 'r' })).toMatchObject({ endpoint: 'https://e.test', key: 'uk_e', release: 'r' })
    expect(parseArgs(['--help'], {}).help).toBe(true)
  })
  it('rejects bad input', () => {
    expect(() => parseArgs(['dist'], {})).toThrow(/endpoint/)
    expect(() => parseArgs(['--endpoint', 'https://w.test', 'dist'], {})).toThrow(/key/)
    expect(() => parseArgs(['--endpoint', 'https://w.test', '--key', 'k'], {})).toThrow(/directory/)
    expect(() => parseArgs(['--nope', '1'], {})).toThrow(/Unknown/)
    expect(() => parseArgs(['--key'], {})).toThrow(/Missing value/)
  })
  it('walks directories for *.js.map', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wgo-cli-'))
    mkdirSync(join(d, 'assets', 'deep'), { recursive: true })
    for (const f of ['a.js', 'a.js.map', 'assets/b.js.map', 'assets/deep/c.js.map', 'assets/style.css.map']) writeFileSync(join(d, f), '{}')
    expect((await findMaps([d])).map((p: string) => p.slice(d.length + 1))).toEqual(['a.js.map', 'assets/b.js.map', 'assets/deep/c.js.map'])
  })
})
