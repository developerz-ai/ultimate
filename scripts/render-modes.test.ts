// The enforcement half of `scripts/render-modes.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a second declaration of the route vocabulary
// fails `bun run verify` with no extra wiring. The real repo is asserted NON-VACUOUSLY — a scanner
// that read nothing would otherwise report "no copies", the same answer a clean repo gives.

import { describe, expect, test } from 'bun:test';
import { HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES } from '@ultimat3/core';
import { repoRoot } from './lib/run';
import type { SourceFile } from './render-modes';
import {
  COPY_THRESHOLD,
  checkVocabulary,
  readSources,
  scanLiteralSets,
  VOCABULARIES,
  VOCABULARY_MODULE,
  vocabularyFindings,
} from './render-modes';

const ROOT = repoRoot();

/** A stand-in for the real tier-0 module, so a unit test never depends on the repo's own text. */
const sanctioned: SourceFile = {
  at: VOCABULARY_MODULE,
  text: [
    `export const RENDER_MODES = [${RENDER_MODES.map((m) => `'${m}'`).join(', ')}] as const;`,
    'export type RenderMode = (typeof RENDER_MODES)[number];',
    `export const OFFLINE_STRATEGIES = [${OFFLINE_STRATEGIES.map((m) => `'${m}'`).join(', ')}] as const;`,
    `export const HYDRATE_STRATEGIES = [${HYDRATE_STRATEGIES.map((m) => `'${m}'`).join(', ')}] as const;`,
    '',
  ].join('\n'),
};

const file = (at: string, text: string): SourceFile => ({ at, text });

describe('a second declaration of the vocabulary', () => {
  test('is reported even under a different NAME — that is how PwaRenderMode survived', () => {
    const findings = checkVocabulary([
      sanctioned,
      file('packages/pwa/src/strategies.ts', "export type PwaRenderMode = 'static' | 'isr';\n"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('PwaRenderMode');
    expect(findings[0]?.cause).toContain('RENDER_MODES');
    expect(findings[0]?.at).toBe('packages/pwa/src/strategies.ts:1');
    expect(findings[0]?.fix).toContain('@ultimat3/core');
  });

  test('is reported when it is a PARTIAL copy — the drift shape, not just the whole set', () => {
    const findings = checkVocabulary([
      sanctioned,
      file('packages/seo/src/routes.ts', "\nexport type RenderMode = 'static' | 'isr' | 'ssr';\n"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('packages/seo/src/routes.ts:2');
  });

  test('is reported when it is an as-const ARRAY rather than a union', () => {
    const findings = checkVocabulary([
      sanctioned,
      file('packages/http/src/router.ts', "const MODES = ['precache', 'runtime'] as const;\n"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('OFFLINE_STRATEGIES');
  });

  test('is reported when it gains a member the vocabulary does not have', () => {
    const drifted = "export type RenderMode = 'static' | 'isr' | 'ssr' | 'stream' | 'spa';\n";
    expect(checkVocabulary([sanctioned, file('packages/x/src/a.ts', drifted)])).toHaveLength(1);
  });

  test('is NOT reported for a set that merely shares one member', () => {
    const cacheTier = "export type CacheTier = 'memo' | 'lru' | 'shared' | 'isr' | 'cdn';\n";
    const strategy = "export type StrategyName = 'cache-first' | 'network-only';\n";
    expect(
      checkVocabulary([
        sanctioned,
        file('packages/core/src/config.ts', cacheTier),
        file('packages/pwa/src/strategies.ts', strategy),
      ]),
    ).toEqual([]);
  });

  test('is not reported against the one module allowed to declare it', () => {
    expect(checkVocabulary([sanctioned])).toEqual([]);
  });
});

describe('the scan cannot pass by reading nothing', () => {
  test('no files at all is a finding, not agreement', () => {
    const findings = checkVocabulary([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('no files');
  });

  test('the vocabulary module missing from the walk is a finding', () => {
    const findings = checkVocabulary([file('packages/pwa/src/a.ts', "type A = 'static' | 'isr';")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain(VOCABULARY_MODULE);
  });

  test('a vocabulary module the scan cannot read is a finding, never zero copies', () => {
    const opaque = file(VOCABULARY_MODULE, 'export const RENDER_MODES = modesFromSomewhere();\n');
    const findings = checkVocabulary([
      opaque,
      file('packages/pwa/src/a.ts', "export type P = 'static' | 'isr' | 'ssr';\n"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('does not declare');
  });
});

describe('a declaration the old scan could not see', () => {
  test('is reported when it is NESTED — a namespace is not a hiding place', () => {
    const nested =
      'export namespace Compat {\n' +
      "  export type PwaRenderMode = 'static' | 'isr' | 'ssr';\n" +
      '}\n';
    const findings = checkVocabulary([sanctioned, file('packages/pwa/src/compat.ts', nested)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('packages/pwa/src/compat.ts:2');
  });

  test('is reported when a doc comment sits BETWEEN the members', () => {
    const documented =
      'export type RenderMode =\n' +
      '  /** Prerendered at build. */\n' +
      "  | 'static'\n" +
      '  /** Revalidated on a tag. */\n' +
      "  | 'isr';\n";
    const findings = checkVocabulary([sanctioned, file('packages/seo/src/m.ts', documented)]);
    expect(findings).toHaveLength(1);
  });

  test('is NOT reported when it is QUOTED inside a template literal', () => {
    const template =
      'export const routeTemplate = `\n' +
      "export type RenderMode = 'static' | 'isr' | 'ssr';\n" +
      '`;\n';
    expect(
      checkVocabulary([sanctioned, file('packages/cli/src/templates/route.ts', template)]),
    ).toEqual([]);
  });

  test('is NOT reported when it is COMMENTED OUT', () => {
    const commented = "// export type RenderMode = 'static' | 'isr' | 'ssr';\n";
    expect(checkVocabulary([sanctioned, file('packages/pwa/src/a.ts', commented)])).toEqual([]);
  });
});

describe('what the scanner reads', () => {
  test('a set below the copy threshold is not a set it reports at all', () => {
    expect(scanLiteralSets("export type One = 'static';\n")).toEqual([]);
    expect(scanLiteralSets("export type Two = 'static' | 'isr';\n")).toHaveLength(1);
    expect(COPY_THRESHOLD).toBe(2);
  });

  test('a computed union is read as no set — silence, which the vacuity guard covers', () => {
    expect(scanLiteralSets('export type X = keyof typeof MODE_SPECS;\n')).toEqual([]);
  });
});

describe('this repository', () => {
  test('declares the route vocabulary exactly once', async () => {
    expect(await vocabularyFindings(ROOT)).toEqual([]);
  });

  test('and the scan really walked shipped source, skipping tests', async () => {
    const files = await readSources(ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((one) => one.at === VOCABULARY_MODULE)).toBe(true);
    expect(files.filter((one) => one.at.includes('.test.'))).toEqual([]);
  });

  test('and the scan found all three vocabularies in the module that owns them', async () => {
    const text = await Bun.file(`${ROOT}/${VOCABULARY_MODULE}`).text();
    const names = scanLiteralSets(text).map((one) => one.name);
    for (const vocabulary of VOCABULARIES) expect(names).toContain(vocabulary.name);
    expect(VOCABULARIES).toHaveLength(3);
  });

  test('and it reads a real union whose members carry a doc comment each', async () => {
    const text = await Bun.file(`${ROOT}/packages/money/src/rounding.ts`).text();
    const set = scanLiteralSets(text).find((one) => one.name === 'RoundingMode');
    expect(set?.members).toEqual(['half-up', 'half-even', 'down', 'up']);
  });

  test('and it reads no declaration out of a real scaffold TEMPLATE, which only quotes one', async () => {
    const at = 'packages/cli/src/templates/scaffold-domain-package.ts';
    const text = await Bun.file(`${ROOT}/${at}`).text();
    expect(text).toContain("export const ROLES = ['owner', 'member', 'viewer'] as const;");
    expect(scanLiteralSets(text).map((one) => one.name)).not.toContain('ROLES');
  });
});
