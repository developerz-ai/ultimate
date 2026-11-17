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
    'ps -o user= -p 4242   # then, as that user: x stop --json',
    "printf '%s\\n' '**/*.test.ts' >> Dockerfile.dockerignore && bun run scripts/image-contract.ts",
    'wc -c .secrets.key   # 65 is a whole key and its newline',
    'file public/hero.png   # reports what these bytes actually are',
    'timedatectl status   # System clock synchronized: yes',
    "find packages -name '*.tsbuildinfo' -delete",
    `find packages/\${dir}/src \${SWEEP_PREDICATE} -delete`,
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
    "case 'refunded':   // the variant the cause names, in the switch that threw",
    'case Status.Refunded: return refund(order);',
    'case 3:',
    'sql`select * from orders where id = $1`   // a parameter, never a splice',
    'sql\\`select 1\\`   // as the scan reads it out of a template literal',
  ])('%s', (fix) => {
    expect(fixShape(fix)).toBe('code');
  });
});

// "An edit naming a file" is the third shape the error contract names: the file, the line, then
// the instruction — opened in an editor at that line, never translated first.
describe('an edit at a file and line', () => {
  test.each([
    'edit scripts/lib/x-pins.ts:3 — add // why: <reason>',
    "edit apps/web/app/post/post-form.island.tsx:28 — delete the import of './repo'",
    `edit \${site.file}:\${site.line} — replace fetch with clientTransport`,
    `edit \${commentSafe(entry)}:\${cut.line} — delete the import`,
  ])('%s', (fix) => {
    expect(fixShape(fix)).toBe('edit');
  });
});

describe('prose', () => {
  test.each([
    'set pwa.offline.fallback in app.config.ts to a path a route serves',
    'add a row for X_A to wiki/Error-Codes.md',
    'edit the config — add a row',
    'edit scripts/lib/x-pins.ts — add // why: <reason>',
    'edit README:3 — add a line',
    'edit scripts/lib/x-pins.ts:3 add a line',
    'sign in again',
    'set OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318',
    'rewrite (the fix) as a command',
    'run x verify — it names the step',
    'Note: the bucket is private',
    'case by case: decide which variant applies',
    'case closed — nothing to do',
    'find the row the cause names and delete it',
    'use `x dev` and watch the log',
    'sql is the tag — sql`select 1`',
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

  // A substituted SEGMENT of a call's receiver is still a call: the receiver is the value, the
  // shape is the paste. Read before the opening-substitution rule, or the second one never counts.
  test.each([
    `db.\${batch.entity}.andWhere('id', 'in', ids).all()`,
    `\${entityName}.findById(id)`,
    `\${name}(input)`,
  ])('a call through a substituted receiver is code: %s', (fix) => {
    expect(fixShape(fix)).toBe('code');
  });

  test('a substitution with no call after it stays unknown, and prose after one never reads as code', () => {
    expect(fixShape(`\${x} --json`)).toBe('unknown');
    expect(fixShape(`\${x} is wrong`)).toBe('unknown');
    expect(fixShape(`\${x}.field is wrong`)).toBe('unknown');
    expect(fixShape(`the \${x}.find(id) call`)).toBe('prose');
  });
});
