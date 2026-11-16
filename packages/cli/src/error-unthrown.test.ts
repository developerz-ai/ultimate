// A registered code no shipped source constructs, against a fixture monorepo on disk: reported
// unless it is LISTED as unthrown (`UNTHROWN_CODES`) or sits under the reserved heading. A row's
// prose waives nothing — a sentence that happens to say "not thrown" is not a decision.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); a fixture lives outside the checkout, where a parallel worker
// globbing the tree cannot meet it half-deleted.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import type { ErrorCodePage } from './error-contract';
import {
  checkErrorCodesThrown,
  checkErrorCodesThrownIn,
  declaredUnthrown,
  declaredUnthrownIn,
} from './error-unthrown';
import { UNTHROWN_CODES } from './unthrown-codes';

// Under the git-ignored fixture parent, so a crashed run leaves nothing a status would show.
const ROOT = join(tmpdir(), `x-error-unthrown-${process.pid}`);
const INDEX = 'wiki/Error-Codes.md';
const PAGE = 'wiki/Error-Codes-demo.md';

const REGISTRY = `export const DEMO_ERROR_CODES = [
  'X_DEMO_THROWN',
  'X_DEMO_TABLE',
  'X_DEMO_FALLBACK',
  'X_DEMO_GHOST',
] as const;
export const DEMO_ERROR_TITLES = { X_DEMO_THROWN: 'a', X_DEMO_TABLE: 'b', X_DEMO_FALLBACK: 'c', X_DEMO_GHOST: 'd' };
export const TABLE = { tableCase: 'X_DEMO_TABLE' };
export const fallback = (x?: string): string => x ?? 'X_DEMO_FALLBACK';
`;

const ownerPage = (ghostRow: string): string =>
  [
    '| Code | Meaning |',
    '|---|---|',
    '| `X_DEMO_THROWN` | thrown |',
    '| `X_DEMO_TABLE` | raised through the table |',
    '| `X_DEMO_FALLBACK` | the fallback |',
    ghostRow,
    '',
  ].join('\n');

/** The set the host reads: the index (with its reserved block) and demo's owner page. */
const pages = (ghostRow: string, reserved = ''): readonly ErrorCodePage[] => [
  { path: INDEX, text: `# Error codes\n\n## Reserved codes\n\n${reserved}\n` },
  { path: PAGE, text: ownerPage(ghostRow) },
];

async function tree(): Promise<void> {
  await Bun.write(join(ROOT, 'packages/demo/src/errors.ts'), REGISTRY);
  await Bun.write(
    join(ROOT, 'packages/demo/src/throw.ts'),
    "import { TABLE } from './errors';\nexport const a = { code: 'X_DEMO_THROWN' };\nexport const b = TABLE.tableCase;\n",
  );
  // A TEST naming the ghost is not a thrower — nor is a gate script.
  await Bun.write(join(ROOT, 'packages/demo/src/throw.test.ts'), "const c = 'X_DEMO_GHOST';\n");
  await Bun.write(join(ROOT, 'scripts/gate.ts'), "const c = 'X_DEMO_GHOST';\n");
}

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('checkErrorCodesThrownIn', () => {
  test('a registered code only a test and a script name is X_ERROR_CODE_UNTHROWN', async () => {
    await tree();
    const findings = await checkErrorCodesThrownIn(
      ROOT,
      pages('| `X_DEMO_GHOST` | the ghost |'),
      new Set(),
    );

    expect(findings.map((finding) => finding.code)).toEqual(['X_ERROR_CODE_UNTHROWN']);
    expect(findings[0]?.at).toBe(PAGE);
    expect(findings[0]?.cause).toContain('X_DEMO_GHOST');
    expect(findings[0]?.cause).toContain('Add it to UNTHROWN_CODES');
    expect(findings[0]?.fix).toBe('x errors explain X_ERROR_CODE_UNTHROWN --json');
  });

  test('its row merely SAYING "thrown by nothing" waives nothing — the prose match is gone', async () => {
    await tree();
    const ghost = pages('| `X_DEMO_GHOST` | **registered, thrown by nothing since 21.0.0** |');
    const findings = await checkErrorCodesThrownIn(ROOT, ghost, new Set());
    expect(findings.map((finding) => finding.code)).toEqual(['X_ERROR_CODE_UNTHROWN']);
    expect(findings[0]?.cause).toContain('UNTHROWN_CODES in packages/cli/src/unthrown-codes.ts');
  });

  test('a code in the listed set is the declaration, and silences it', async () => {
    await tree();
    const ghost = pages('| `X_DEMO_GHOST` | **registered, thrown by nothing since 21.0.0** |');
    expect(await checkErrorCodesThrownIn(ROOT, ghost, new Set(['X_DEMO_GHOST']))).toEqual([]);
  });

  // The reserved block lives on the INDEX now, not on the owner page: reading only the owner page
  // would miss it and report a reserved code as unthrown.
  test('a code under the index reserved heading is not reported', async () => {
    await tree();
    const reserved = pages('', '| `X_DEMO_GHOST` | reserved |');
    expect(await checkErrorCodesThrownIn(ROOT, reserved, new Set())).toEqual([]);
  });

  test('an empty reference reports nothing: the docs half owns that finding', async () => {
    await tree();
    expect(await checkErrorCodesThrownIn(ROOT, [], new Set())).toEqual([]);
  });

  test('a listed code that is thrown again is a stale listing; an unregistered name is inert', async () => {
    await tree();
    const listed = new Set(['X_DEMO_GHOST', 'X_DEMO_THROWN', 'X_DEMO_NEVER']);
    const findings = await checkErrorCodesThrownIn(ROOT, pages('| `X_DEMO_GHOST` | x |'), listed);
    expect(findings.map((finding) => [finding.code, finding.cause.split(' ')[0]])).toEqual([
      ['X_ERROR_CODE_UNTHROWN_STALE', 'X_DEMO_THROWN'],
    ]);
    expect(findings[0]?.cause).toContain('delete it from UNTHROWN_CODES');
    expect(findings[0]?.fix).toBe('x errors explain X_ERROR_CODE_UNTHROWN_STALE --json');
  });

  test('the shipped list is the seven codes this repo retired without a thrower', () => {
    // `X_RPC_FAILED`'s row says "thrown by nothing", and `@ultimat3/action` still constructs it in a
    // class kept exported — so it was never the prose waiver that kept it green, and it is not listed.
    expect([...UNTHROWN_CODES].sort()).toEqual([
      'X_DB_STUDIO_FAILED',
      'X_LIVE_CLIENT_MISSING',
      'X_PWA_SYNC_FLUSH_FAILED',
      'X_PWA_SYNC_INCOMPLETE',
      'X_QUERY_NOT_SUBSCRIBABLE',
      'X_SHIPPED_GUARD_MISSING',
      'X_TEST_SHARD_FAILED',
    ]);
  });

  // Each page is read on its own: the index's reserved block must not leak onto the page after it.
  test('a code under the reserved heading is declared unthrown by where it sits', () => {
    const index = '| `X_A` | not thrown |\n## Reserved codes\n| `X_B` | reserved |\n';
    const owner = '| `X_C` | live |\n';
    expect([
      ...declaredUnthrownIn([
        { path: INDEX, text: index },
        { path: PAGE, text: owner },
      ]),
    ]).toEqual(['X_B']);
  });
});

// The deprecated single-page names, kept for a minor: one page path, one markdown string.
describe('the deprecated single-page names', () => {
  test('checkErrorCodesThrown reads its one page; an absent page reports nothing', async () => {
    await tree();
    expect(await checkErrorCodesThrown(ROOT, INDEX, new Set())).toEqual([]);
    await Bun.write(join(ROOT, INDEX), '| `X_DEMO_GHOST` | the ghost |\n');
    const findings = await checkErrorCodesThrown(ROOT, INDEX, new Set());
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_ERROR_CODE_UNTHROWN', INDEX],
    ]);
  });

  test('declaredUnthrown reads one markdown string', () => {
    const page = '| `X_A` | live |\n## Reserved codes\n| `X_B` | reserved |\n';
    expect([...declaredUnthrown(page)]).toEqual(['X_B']);
  });
});
