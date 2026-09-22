// A `fix:` is pasted, so an import specifier inside one has to resolve. This is the mechanical
// half of axiom 4 for this package's own name: every `@ultimat3/realtime/<subpath>` written
// anywhere in the shipped source must be a subpath `package.json`'s `exports` declares.

import { describe, expect, test } from 'bun:test';

const SRC = import.meta.dir;

/** `@ultimat3/realtime`, optionally followed by one subpath segment. */
const SPECIFIER = /@ultimat3\/realtime(\/[a-zA-Z0-9._-]+)?/g;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

async function declaredSubpaths(): Promise<readonly string[]> {
  const parsed: unknown = await Bun.file(`${SRC}/../package.json`).json();
  const exports =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { exports?: unknown }).exports
      : undefined;
  if (typeof exports !== 'object' || exports === null) return [];
  return Object.keys(exports);
}

/** Every shipped module — `*.test.ts` and `*-fixture.ts` are excluded from the tarball. */
function shippedSources(): readonly string[] {
  return [...new Bun.Glob('*.ts').scanSync({ cwd: SRC })]
    .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('-fixture.ts'))
    .sort();
}

async function selfSpecifierSites(): Promise<readonly Site[]> {
  const sites: Site[] = [];
  for (const file of shippedSources()) {
    const lines = (await Bun.file(`${SRC}/${file}`).text()).split('\n');
    lines.forEach((text, index) => {
      for (const match of text.matchAll(SPECIFIER)) {
        sites.push({ file, line: index + 1, specifier: match[0] });
      }
    });
  }
  return sites;
}

describe('a specifier written into shipped source resolves', () => {
  test('every @ultimat3/realtime subpath is one the package exports', async () => {
    const declared = await declaredSubpaths();
    // Sanity: a package.json this test could not read would make every case below vacuous.
    expect(declared).toContain('.');
    expect(shippedSources().length).toBeGreaterThan(50);

    const unresolvable = (await selfSpecifierSites()).filter((site) => {
      const subpath = site.specifier.slice('@ultimat3/realtime'.length);
      return !declared.includes(subpath === '' ? '.' : `.${subpath}`);
    });

    expect(unresolvable).toEqual([]);
  });
});
