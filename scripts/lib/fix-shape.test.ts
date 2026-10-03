// What a `fix:` line IS, read off its first word: a command to run, a code shape to paste, or prose.
// The prose side is the population `scripts/fix-prose.ts` ratchets down.

import { describe, expect, test } from 'bun:test';
import { fixShape } from './fix-shape';

describe('a runnable command', () => {
  test.each([
    'x db migrate',
    'x errors explain X_A --json   # then add the row',
    'bun run scripts/fix-prose.ts --explain --json',
    'bunx tsc -b',
    'git fetch --no-tags --depth=1 origin main',
    'docker compose up -d',
    'psql "$DATABASE_URL" -c "select 1"',
    'bin/check --json',
    './bin/probe',
    'TRUSTED_PROXY_HOPS=1 ROLE=web bun apps/web/server.ts',
    'export DATABASE_URL=postgres://localhost/app',
    '`x verify --json`',
    'curl -sS http://localhost:3000/_x',
  ])('%s', (fix) => {
    expect(fixShape(fix)).toBe('command');
  });
});

describe('a code shape to paste', () => {
  test.each([
    "defineRoute({ ..., post: '<actionExportName>' })",
    "histogram('orders_total', { bounds: [1, 2] })",
    'await db.transaction(async (tx) => {})',
    'new UltimateError({ code, cause, fix })',
    "import { t } from '@ultimat3/schema'",
    "{ jsonrpc: '2.0', id, method, params }",
    `idempotencyKey: (input) => \`job:\${input.id}\``,
    "timeZone: 'UTC'",
    'expect.unreachable(`no refusal`)',
    'ALTER TABLE posts ADD COLUMN slug text',
    '<AsyncRegion state={state} />',
  ])('%s', (fix) => {
    expect(fixShape(fix)).toBe('code');
  });
});

describe('prose', () => {
  test.each([
    'set pwa.offline.fallback in app.config.ts to a path a route serves',
    'add a row for X_A to wiki/Error-Codes.md',
    'edit scripts/lib/x-pins.ts:3 — add // why: <reason>',
    'sign in again',
    'set OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318',
    'rewrite (the fix) as a command',
    'run x verify — it names the step',
    'Note: the bucket is private',
    '',
  ])('%s', (fix) => {
    expect(fixShape(fix)).toBe('prose');
  });
});

describe('a fix the scan cannot judge', () => {
  test('one that OPENS with a substitution is computed at run time — never counted either way', () => {
    expect(fixShape(`\${command} --json`)).toBe('unknown');
    expect(fixShape(`  \${fix}`)).toBe('unknown');
  });
});
