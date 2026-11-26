import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/lib/schema';

/**
 * The schema migration (handlers/migrate.ts) only re-runs when SchemaHash in template.yaml changes. A schema change
 * deployed without a bump leaves new tables and columns missing, and the API fails on them. This test fails until
 * both are updated together: bump SchemaHash in template.yaml, then record it here with the digest it prints.
 */
const RECORDED: Record<string, string> = {
  '2026-11-26-4': 'dc6ad708b2fbcd82',
};

describe('schema migration', () => {
  it('has a new SchemaHash for every change to src/lib/schema.ts', () => {
    const digest = createHash('sha256').update(SCHEMA_STATEMENTS.join('\n;\n')).digest('hex').slice(0, 16);
    const hash = /SchemaHash: '([^']+)'/.exec(readFileSync(new URL('../template.yaml', import.meta.url), 'utf8'))?.[1];
    const hint = `src/lib/schema.ts is at digest ${digest} and template.yaml at SchemaHash ${hash}. After changing the schema, bump SchemaHash in template.yaml and set RECORDED in this test to { '<new SchemaHash>': '${digest}' }.`;
    expect(RECORDED[hash ?? ''], hint).toBe(digest);
  });
});
