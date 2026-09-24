// A registered code no shipped source constructs, against a fixture monorepo on disk: reported
// unless its reference row says, in words, that nothing throws it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); a fixture lives outside the checkout, where a parallel worker
// globbing the tree cannot meet it half-deleted.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { checkErrorCodesThrown, declaredUnthrown } from './error-unthrown';

// Under the git-ignored fixture parent, so a crashed run leaves nothing a status would show.
const ROOT = join(tmpdir(), `x-error-unthrown-${process.pid}`);
const PAGE = 'wiki/Error-Codes.md';

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

const reference = (ghostRow: string): string =>
  [
    '| Code | Meaning |',
    '|---|---|',
    '| `X_DEMO_THROWN` | thrown |',
    '| `X_DEMO_TABLE` | raised through the table |',
    '| `X_DEMO_FALLBACK` | the fallback |',
    ghostRow,
    '',
  ].join('\n');

async function tree(ghostRow: string): Promise<void> {
  await Bun.write(join(ROOT, 'packages/demo/src/errors.ts'), REGISTRY);
  await Bun.write(
    join(ROOT, 'packages/demo/src/throw.ts'),
    "import { TABLE } from './errors';\nexport const a = { code: 'X_DEMO_THROWN' };\nexport const b = TABLE.tableCase;\n",
  );
  // A TEST naming the ghost is not a thrower — nor is a gate script.
  await Bun.write(join(ROOT, 'packages/demo/src/throw.test.ts'), "const c = 'X_DEMO_GHOST';\n");
  await Bun.write(join(ROOT, 'scripts/gate.ts'), "const c = 'X_DEMO_GHOST';\n");
  await Bun.write(join(ROOT, PAGE), reference(ghostRow));
}

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('checkErrorCodesThrown', () => {
  test('a registered code only a test and a script name is X_ERROR_CODE_UNTHROWN', async () => {
    await tree('| `X_DEMO_GHOST` | the ghost |');
    const findings = await checkErrorCodesThrown(ROOT, PAGE);

    expect(findings.map((finding) => finding.code)).toEqual(['X_ERROR_CODE_UNTHROWN']);
    expect(findings[0]?.cause).toContain('X_DEMO_GHOST');
    expect(findings[0]?.fix).toContain('thrown by nothing');
  });

  test('its row saying "thrown by nothing" is the declaration, and silences it', async () => {
    await tree('| `X_DEMO_GHOST` | **registered, thrown by nothing since 21.0.0** |');
    expect(await checkErrorCodesThrown(ROOT, PAGE)).toEqual([]);
  });

  test('a code under the reserved heading is declared unthrown by where it sits', () => {
    const page = '| `X_A` | live |\n## Reserved codes\n| `X_B` | reserved |\n';
    expect([...declaredUnthrown(page)]).toEqual(['X_B']);
  });
});
