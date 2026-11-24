import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findMaps, parseArgs } from '../bin/wgo-sourcemaps.mjs'

describe('wgo-sourcemaps', () => {
  it('parses flags, env and paths', () => {
    const o = parseArgs(['--endpoint', 'https://w.test/', '--key=uk_1', '--release', 'v1', 'dist/'], {})
    assert.equal(o.endpoint, 'https://w.test')
    assert.equal(o.key, 'uk_1')
    assert.equal(o.release, 'v1')
    assert.deepEqual(o.paths, ['dist/'])
    const e = parseArgs(['dist'], { WGO_ENDPOINT: 'https://e.test', WGO_UPLOAD_KEY: 'uk_e', WGO_RELEASE: 'r' })
    assert.equal(e.endpoint, 'https://e.test')
    assert.equal(e.key, 'uk_e')
    assert.equal(e.release, 'r')
    assert.equal(parseArgs(['--help'], {}).help, true)
  })
  it('rejects bad input', () => {
    assert.throws(() => parseArgs(['dist'], {}), /endpoint/)
    assert.throws(() => parseArgs(['--endpoint', 'https://w.test', 'dist'], {}), /key/)
    assert.throws(() => parseArgs(['--endpoint', 'https://w.test', '--key', 'k'], {}), /directory/)
    assert.throws(() => parseArgs(['--nope', '1'], {}), /Unknown/)
    assert.throws(() => parseArgs(['--key'], {}), /Missing value/)
  })
  it('walks directories for *.js.map', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wgo-cli-'))
    mkdirSync(join(d, 'assets', 'deep'), { recursive: true })
    for (const f of ['a.js', 'a.js.map', 'assets/b.js.map', 'assets/deep/c.js.map', 'assets/style.css.map']) writeFileSync(join(d, f), '{}')
    assert.deepEqual((await findMaps([d])).map((p) => p.slice(d.length + 1)), ['a.js.map', 'assets/b.js.map', 'assets/deep/c.js.map'])
  })
})
