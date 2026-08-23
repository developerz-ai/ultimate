// The enforcement half of `scripts/render-modes.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a second declaration of the route vocabulary
// fails `bun run verify` with no extra wiring. The real repo is asserted NON-VACUOUSLY — a scanner
// that read nothing would otherwise report "no copies", the same answer a clean repo gives.

import { describe, expect, test } from 'bun:test';
import {
  CACHE_TIERS,
  HYDRATE_STRATEGIES,
  IMAGE_FORMATS,
  OFFLINE_STRATEGIES,
  RENDER_MODES,
} from '@ultimat3/core';
import { JOB_STATES } from '@ultimat3/jobs';
import { TEST_TYPES } from '@ultimat3/testing';
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

const asConst = (name: string, members: readonly string[]): string =>
  `export const ${name} = [${members.map((m) => `'${m}'`).join(', ')}] as const;`;

/** Stand-ins for the real owning modules, so a unit test never depends on the repo's own text. */
const sanctioned: SourceFile = {
  at: VOCABULARY_MODULE,
  text: [
    asConst('RENDER_MODES', RENDER_MODES),
    'export type RenderMode = (typeof RENDER_MODES)[number];',
    asConst('OFFLINE_STRATEGIES', OFFLINE_STRATEGIES),
    asConst('HYDRATE_STRATEGIES', HYDRATE_STRATEGIES),
    '',
  ].join('\n'),
};

/**
 * Every vocabulary needs its owner in the walk, not just the route one: the vacuity guard reports
 * an owning module missing from the scan rather than answering "no copies", which is the same
 * answer a clean repo gives.
 */
const OWNERS: readonly SourceFile[] = [
  sanctioned,
  { at: 'packages/jobs/src/driver.ts', text: asConst('JOB_STATES', JOB_STATES) },
  { at: 'packages/testing/src/test-types.ts', text: asConst('TEST_TYPES', TEST_TYPES) },
  { at: 'packages/core/src/image/probe.ts', text: asConst('IMAGE_FORMATS', IMAGE_FORMATS) },
  { at: 'packages/core/src/cache-vocabulary.ts', text: asConst('CACHE_TIERS', CACHE_TIERS) },
];

const file = (at: string, text: string): SourceFile => ({ at, text });

describe('a second declaration of the vocabulary', () => {
  test('is reported even under a different NAME — that is how PwaRenderMode survived', () => {
    const findings = checkVocabulary([
      ...OWNERS,
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
      ...OWNERS,
      file('packages/seo/src/routes.ts', "\nexport type RenderMode = 'static' | 'isr' | 'ssr';\n"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('packages/seo/src/routes.ts:2');
  });

  test('is reported when it is an as-const ARRAY rather than a union', () => {
    const findings = checkVocabulary([
      ...OWNERS,
      file('packages/http/src/router.ts', "const MODES = ['precache', 'runtime'] as const;\n"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('OFFLINE_STRATEGIES');
  });

  test('is reported when it gains a member the vocabulary does not have', () => {
    const drifted = "export type RenderMode = 'static' | 'isr' | 'ssr' | 'stream' | 'spa';\n";
    expect(checkVocabulary([...OWNERS, file('packages/x/src/a.ts', drifted)])).toHaveLength(1);
  });

  test('is NOT reported for a set that merely shares one member', () => {
    // `network-only` against OFFLINE_STRATEGIES, `never` against HYDRATE_STRATEGIES, `redis`
    // against CACHE_TIERS: one shared member each, and three vocabularies that genuinely differ.
    const strategy = "export type StrategyName = 'cache-first' | 'network-only';\n";
    const freq = "export type ChangeFreq = 'daily' | 'weekly' | 'never';\n";
    const transport = "export type RealtimeTransport = 'memory' | 'nats' | 'redis';\n";
    expect(
      checkVocabulary([
        ...OWNERS,
        file('packages/pwa/src/strategies.ts', strategy),
        file('packages/seo/src/sitemap.ts', freq),
        file('packages/core/src/config.ts', transport),
      ]),
    ).toEqual([]);
  });

  test('is reported for the cache-tier pair issue #293 shipped — two shared members', () => {
    // `app.config.ts` accepted this union through 8.0.0 while the ladder ordered by
    // `request-memo | lru | redis | cdn`: `lru` and `cdn` shared, which is exactly the threshold,
    // and `isr` accepted by config and served by no tier. Before this row existed the whole
    // divergence was invisible to the one gate built to catch it.
    const legacy = "export type CacheTier = 'memo' | 'lru' | 'shared' | 'isr' | 'cdn';\n";
    const findings = checkVocabulary([...OWNERS, file('packages/core/src/config.ts', legacy)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('CACHE_TIERS');
    expect(findings[0]?.fix).toContain("import CACHE_TIERS from '@ultimat3/core'");
  });

  test('is not reported against the one module allowed to declare it', () => {
    expect(checkVocabulary([...OWNERS])).toEqual([]);
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
      ...OWNERS.slice(1),
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
    const findings = checkVocabulary([...OWNERS, file('packages/pwa/src/compat.ts', nested)]);
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
    const findings = checkVocabulary([...OWNERS, file('packages/seo/src/m.ts', documented)]);
    expect(findings).toHaveLength(1);
  });

  test('is NOT reported when it is QUOTED inside a template literal', () => {
    const template =
      'export const routeTemplate = `\n' +
      "export type RenderMode = 'static' | 'isr' | 'ssr';\n" +
      '`;\n';
    expect(
      checkVocabulary([...OWNERS, file('packages/cli/src/templates/route.ts', template)]),
    ).toEqual([]);
  });

  test('is NOT reported when it is COMMENTED OUT', () => {
    const commented = "// export type RenderMode = 'static' | 'isr' | 'ssr';\n";
    expect(checkVocabulary([...OWNERS, file('packages/pwa/src/a.ts', commented)])).toEqual([]);
  });
});

describe('a vocabulary of ordinary words, compared by NAME', () => {
  test('a second JOB_STATES is reported wherever it is declared', () => {
    // `packages/cli/src/jobs-report.ts` carried one, and it was ONE MEMBER SHORT: `x jobs cancel`
    // created a state `x jobs ls --state cancelled` then refused to filter on.
    const copy = asConst('JOB_STATES', ['ready', 'running', 'done']);
    const findings = checkVocabulary([...OWNERS, file('packages/cli/src/jobs-report.ts', copy)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix).toContain("import JOB_STATES from '@ultimat3/jobs'");
  });

  test('a RELATED set under its own name is not a copy — the eleven that would have red', () => {
    // `SERIAL_TYPES` is a subset of the test types, `ENCODABLE_FORMATS` is what the codecs write,
    // `VERIFY_STEP_NAMES` is a superset by construction. Comparing these by literal set reports
    // all three, which is a rule its readers learn to silence.
    const subset = asConst('SERIAL_TYPES', ['live', 'job', 'e2e']);
    const superset = asConst('VERIFY_STEP_NAMES', ['typecheck', ...TEST_TYPES, 'roadmap']);
    expect(
      checkVocabulary([
        ...OWNERS,
        file('packages/cli/src/verify-tests.ts', subset),
        file('packages/cli/src/verify-step.ts', superset),
      ]),
    ).toEqual([]);
  });
});

describe('what the scanner reads', () => {
  test('a TYPED array literal is a declaration — `as const` is not the only shape', () => {
    // The shape the `JOB_STATES` copy was actually written in, and the one the scan could not see.
    const typed = "const PENDING: readonly JobState[] = ['precache', 'runtime'];\n";
    const [set] = scanLiteralSets(typed);
    expect(set?.name).toBe('PENDING');
    expect(set?.members).toEqual(['precache', 'runtime']);
    expect(checkVocabulary([...OWNERS, file('packages/pwa/src/a.ts', typed)])).toHaveLength(1);
  });

  test('a bare array of strings is still not read — that is any list, not a vocabulary', () => {
    expect(scanLiteralSets("const PENDING = ['precache', 'runtime'];\n")).toEqual([]);
  });

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
    for (const vocabulary of VOCABULARIES.filter((one) => one.at === VOCABULARY_MODULE)) {
      expect(names).toContain(vocabulary.name);
    }
    // Seven: the three route sets, JOB_STATES, TEST_TYPES, IMAGE_FORMATS and CACHE_TIERS. The
    // count is pinned so a row is added deliberately, never as a side effect of an import.
    expect(VOCABULARIES).toHaveLength(7);
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
