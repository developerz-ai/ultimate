// The npm-page guard: every publishable package's README opens on what a stranger needs, and its
// `package.json` carries the `keywords` search needs. Negative cases are fixtures — a README string
// and a manifest object — never an edit to a real package, which other suites read concurrently.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkKeywords,
  checkReadmeShape,
  FRONT_LINES,
  type FrontPackage,
  frontFindingsFor,
  packageFrontFindings,
  README_SHAPE_PINS,
  unknownPinFindings,
  WIKI_ROOT,
} from './package-front';

const HOME = `${WIKI_ROOT}/Money`;
const GOOD = [
  '# @ultimat3/money',
  '',
  'Integer minor units with an attached currency, never a float.',
  '',
  '```sh',
  'bun add @ultimat3/money',
  '```',
  '',
  '```ts',
  "import { money } from '@ultimat3/money';",
  "money(1999, 'EUR');",
  '```',
  '',
  `Guide: [Money](${HOME}).`,
].join('\n');

const pkg = (over: Partial<FrontPackage> = {}): FrontPackage => ({
  dir: 'money',
  name: '@ultimat3/money',
  readme: GOOD,
  manifest: { homepage: HOME, keywords: ['ultimate', 'money'] },
  ...over,
});

describe('unit · the first screen of a package README', () => {
  test('a sentence, an install line, an example and the wiki page pass', () => {
    expect(checkReadmeShape(pkg())).toEqual([]);
  });

  test('no install line is refused', () => {
    expect(checkReadmeShape(pkg({ readme: GOOD.replace('bun add @ultimat3/money', '') }))).toEqual([
      'install',
    ]);
  });

  test('an install line for ANOTHER package does not count', () => {
    const readme = GOOD.replace('bun add @ultimat3/money', 'bun add @ultimat3/moneyx');
    expect(checkReadmeShape(pkg({ readme }))).toEqual(['install']);
  });

  test('no example is refused — the install fence alone is not one', () => {
    const readme = GOOD.replace(/```ts[\s\S]*?```\n/, '');
    expect(checkReadmeShape(pkg({ readme }))).toEqual(['example']);
  });

  test('an example below line 30 is refused', () => {
    const padded = GOOD.replace('```ts', `${'filler\n'.repeat(FRONT_LINES)}\`\`\`ts`);
    expect(checkReadmeShape(pkg({ readme: padded }))).toContain('example');
  });

  test('a table where the sentence belongs is refused', () => {
    const readme = GOOD.replace('Integer minor units', '| Owns | Module |\n|---|---|\nInteger');
    expect(checkReadmeShape(pkg({ readme }))).toEqual(['sentence']);
  });

  test('no link to the homepage the manifest names is refused', () => {
    expect(checkReadmeShape(pkg({ readme: GOOD.replace(HOME, 'https://example.com') }))).toEqual([
      'wiki',
    ]);
  });

  test('a homepage that is not a wiki page is refused, even if the README links it', () => {
    const elsewhere = 'https://github.com/developerz-ai/ultimate#readme';
    const readme = GOOD.replace(HOME, elsewhere);
    expect(
      checkReadmeShape(pkg({ readme, manifest: { homepage: elsewhere, keywords: ['x'] } })),
    ).toEqual(['wiki']);
  });

  test('a heading that is not the package name is refused', () => {
    expect(checkReadmeShape(pkg({ readme: GOOD.replace('# @ultimat3/money', '# Money') }))).toEqual(
      ['heading'],
    );
  });

  test('an emoji beside the name is still the heading', () => {
    expect(
      checkReadmeShape(pkg({ readme: GOOD.replace('# @ultimat3/money', '# 💶 @ultimat3/money') })),
    ).toEqual([]);
  });

  test('a fence that runs more than the install is an example (create-ultimate)', () => {
    const readme = [
      '# create-ultimate',
      '',
      'Scaffold an app.',
      '',
      '```sh',
      'bunx create-ultimate myapp && cd myapp && bun run setup',
      '```',
      `[Getting started](${WIKI_ROOT}/Getting-Started)`,
    ].join('\n');
    const manifest = { homepage: `${WIKI_ROOT}/Getting-Started`, keywords: ['x'] };
    expect(
      checkReadmeShape({ dir: 'create-ultimate', name: 'create-ultimate', readme, manifest }),
    ).toEqual([]);
    const bare = readme.replace(' && cd myapp && bun run setup', '');
    expect(
      checkReadmeShape({ dir: 'create-ultimate', name: 'create-ultimate', readme: bare, manifest }),
    ).toEqual(['example']);
  });

  test('the finding names the file and what is missing', () => {
    const found = frontFindingsFor(
      pkg({ readme: GOOD.replace('bun add @ultimat3/money', '') }),
      {},
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_PACKAGE_README_SHAPE');
    expect(found[0]?.at).toBe('packages/money/README.md');
    expect(found[0]?.cause).toContain('install');
    expect(found[0]?.fix).toContain('packages/money/README.md');
  });

  test('a pinned package is not reported, and a pin it no longer needs is', () => {
    const broken = pkg({ readme: GOOD.replace('bun add @ultimat3/money', '') });
    expect(frontFindingsFor(broken, { money: 'reason' })).toEqual([]);
    const stale = frontFindingsFor(pkg(), { money: 'reason' });
    expect(stale.map((finding) => finding.code)).toEqual(['X_PACKAGE_README_SHAPE']);
    expect(stale[0]?.fix).toContain('scripts/package-front.ts');
  });
});

describe('unit · a pin for no package', () => {
  test('is reported, a pin for a real one is not', () => {
    const found = unknownPinFindings(new Set(['money']), { money: 'reason', gone: 'reason' });
    expect(found.map((finding) => finding.cause)).toEqual([
      'README_SHAPE_PINS exempts gone, which is no publishable package',
    ]);
  });
});

describe('unit · keywords', () => {
  test('present and non-empty pass', () => {
    expect(checkKeywords({ keywords: ['ultimate'] })).toBe(true);
  });

  test.each([
    ['absent', {}],
    ['empty', { keywords: [] }],
    ['not strings', { keywords: [1] }],
    ['blank', { keywords: [' '] }],
  ])('%s is refused', (_label, manifest) => {
    expect(checkKeywords(manifest)).toBe(false);
    const found = frontFindingsFor(pkg({ manifest: { ...manifest, homepage: HOME } }), {});
    expect(found.map((finding) => finding.code)).toEqual(['X_PACKAGE_KEYWORDS_MISSING']);
    expect(found[0]?.fix).toContain('packages/money/package.json');
  });
});

describe('repo · every publishable package', () => {
  // Reads the real tree: the repo-scan backstop, not Bun's 5000ms default.
  test(
    'passes, with nothing pinned',
    async () => {
      expect(await packageFrontFindings(repoRoot())).toEqual([]);
      expect(README_SHAPE_PINS).toEqual({});
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
