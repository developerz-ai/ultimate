// The error-code index is generated from the owner pages, a stale one is refused, and a row on a
// page its manifest owner does not hold is refused — the three halves of keeping the split honest.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { errorCodeIndexFindings, misplacedRows } from './error-code-pages';
import { INDEX_CLOSE, INDEX_OPEN, renderIndex, withIndex } from './lib/error-code-index';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

const HEAD = '| Code | Means | Typical cause | Fix |\n|---|---|---|---|';
const core = {
  path: 'wiki/Error-Codes-core.md',
  text: `# core\n\n${HEAD}\n| \`X_A\` | a failed | why | \`x a\` |\n| \`X_B\` / \`X_C\` | b or c | why | \`x b\` |\n`,
};
const scripts = {
  path: 'wiki/Error-Codes-scripts.md',
  text: `# scripts\n\n${HEAD}\n| \`X_GATE\` | the gate \\| failed | why | \`x g\` |\n`,
};
const INDEX = [
  '# Error codes',
  '',
  'intro',
  '',
  INDEX_OPEN,
  'old',
  INDEX_CLOSE,
  '',
  '## Reserved codes',
  '',
].join('\n');

describe('renderIndex', () => {
  const body = renderIndex([core, scripts]);

  test('one row per owner page: its owner, its link, and how many codes it holds', () => {
    expect(body).toContain('| `@ultimat3/core` | [Error-Codes-core](Error-Codes-core) | 3 |');
    expect(body).toContain(
      '| repository scripts | [Error-Codes-scripts](Error-Codes-scripts) | 1 |',
    );
  });

  test('one line per code, sorted, its code cell plain so no row scanner counts it', () => {
    const codes = body.filter((line) => /^\| X_/.test(line));
    expect(codes).toEqual([
      '| X_A | [core](Error-Codes-core) |',
      '| X_B | [core](Error-Codes-core) |',
      '| X_C | [core](Error-Codes-core) |',
      '| X_GATE | [scripts](Error-Codes-scripts) |',
    ]);
    expect(body.some((line) => line.startsWith('| `X_'))).toBe(false);
  });

  test('a code with rows on two pages is listed once per page; twice on one page, once', () => {
    const twice = { path: core.path, text: `${core.text}| \`X_A\` | a again | why | \`x a\` |\n` };
    const other = {
      path: 'wiki/Error-Codes-cli.md',
      text: `${HEAD}\n| \`X_A\` | a | w | \`x\` |\n`,
    };
    const lines = renderIndex([twice, other]).filter((line) => line.startsWith('| X_A |'));
    expect(lines).toEqual([
      '| X_A | [cli](Error-Codes-cli) |',
      '| X_A | [core](Error-Codes-core) |',
    ]);
  });

  test('the index page itself is never an owner', () => {
    const index = { path: 'wiki/Error-Codes.md', text: '| `X_RESERVED` | today |' };
    expect(renderIndex([index, core]).some((line) => line.includes('X_RESERVED'))).toBe(false);
  });
});

describe('withIndex', () => {
  test('the block between the markers is replaced; everything outside it kept', () => {
    const next = withIndex(INDEX, ['new']);
    expect(next).toBe(INDEX.replace('\nold\n', '\nnew\n'));
  });

  test('a page without both markers has no block to fill', () => {
    expect(withIndex('# Error codes\n', ['new'])).toBeUndefined();
  });
});

describe('misplacedRows', () => {
  const owners = new Map([
    ['X_A', 'core'],
    ['X_B', 'cli'],
    ['X_GATE', 'scripts'],
  ]);

  test("a row on a page that is not its first code's owner's", () => {
    expect(misplacedRows([core, scripts], owners)).toEqual([
      { code: 'X_B', at: 'wiki/Error-Codes-core.md:6', owner: 'cli' },
    ]);
  });

  test('a code the manifest does not know yet is no verdict either way', () => {
    expect(misplacedRows([scripts], new Map())).toEqual([]);
  });

  test('a code row on the index, above Reserved codes, belongs on its owner page', () => {
    const index = {
      path: 'wiki/Error-Codes.md',
      text: '| `X_A` | a | w | f |\n## Reserved codes\n| `X_R` | today |\n',
    };
    expect(misplacedRows([index], owners)).toEqual([
      { code: 'X_A', at: 'wiki/Error-Codes.md:1', owner: 'core' },
    ]);
  });
});

describe('errorCodeIndexFindings', () => {
  async function tree(index: string): Promise<string> {
    const dir = await mkdtemp(`${tmpdir()}/error-code-index-`);
    made.push(dir);
    await mkdir(`${dir}/wiki`, { recursive: true });
    await Bun.write(`${dir}/wiki/Error-Codes.md`, index);
    await Bun.write(`${dir}/${core.path}`, core.text);
    return dir;
  }

  test('an index that matches its pages is clean; an edited owner page makes it stale', async () => {
    const root = await tree(withIndex(INDEX, renderIndex([core])) ?? '');
    expect(await errorCodeIndexFindings(root)).toEqual([]);
    await Bun.write(`${root}/${core.path}`, `${core.text}| \`X_D\` | d | w | \`x d\` |\n`);
    const [finding] = await errorCodeIndexFindings(root);
    expect(finding?.code).toBe('X_ERROR_CODE_INDEX_STALE');
    expect(finding?.fix).toBe('bun run scripts/error-code-pages.ts --write');
  });

  test('an index with no markers is stale too, and says where the block goes', async () => {
    const [finding] = await errorCodeIndexFindings(await tree('# Error codes\n'));
    expect(finding?.code).toBe('X_ERROR_CODE_INDEX_STALE');
    expect(finding?.fix).toContain(INDEX_OPEN);
  });

  test(
    'the committed index is what the owner pages generate, and every row is on its owner page',
    async () => {
      expect(await errorCodeIndexFindings(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
