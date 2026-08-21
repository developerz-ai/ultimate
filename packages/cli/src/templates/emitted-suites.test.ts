// A generated test runs under the gate step its FILENAME picks, and the wrapper it calls declares
// which step that has to be. Five generators disagreed with themselves: `x test contract`,
// `x test live` and `x test job` all answered X_TEST_NO_FILES in an app that shipped all three
// kinds of test, because every one of them was written as a plain `<name>.test.ts` and classified
// as a unit test. `x g route` learned this lesson alone (`route.test.ts`); this is it, generalised.

import { describe, expect, test } from 'bun:test';
import type { GenerateOptions } from '../cmd-generate';
import { generate } from '../cmd-generate';
import { scaffoldVariants } from '../scaffold-fixture';
import { stripComments } from '../ts-scan';
import type { TestType } from '../verify-tests';
import { ownerOf } from '../verify-tests';

/** The wrapper an emitted test calls → the step that must own the file it is written into. */
const STEP_OF_WRAPPER: Readonly<Record<string, TestType>> = {
  unitTest: 'unit',
  contractTest: 'contract',
  liveTest: 'live',
  jobTest: 'job',
  e2eTest: 'e2e',
  evalTest: 'eval',
};

/**
 * The wrappers a file CALLS. Comments are masked first with the `errors` step's own masker: every
 * one of these templates explains its wrapper in prose, and reading that as a call would report a
 * finding about a file that is already right.
 */
const wrappersIn = (contents: string): readonly string[] => [
  ...new Set(
    [
      ...stripComments(contents).matchAll(
        /\b(unitTest|contractTest|liveTest|jobTest|e2eTest|evalTest)\(/g,
      ),
    ].flatMap((match) => match[1] ?? []),
  ),
];

interface Emitted {
  readonly from: string;
  readonly path: string;
  readonly contents: string;
}

/** Every generator once, plus every `x new` variant — the same battery the lint rule runs over. */
const BATTERY: readonly GenerateOptions[] = [
  { kind: 'resource', name: 'invoice', admin: true },
  { kind: 'action', name: 'send-invoice', feature: 'invoice' },
  { kind: 'mutator', name: 'rename-invoice', feature: 'invoice' },
  { kind: 'query', name: 'invoice-search', feature: 'invoice' },
  { kind: 'query', name: 'invoice-feed', feature: 'invoice', live: true },
  { kind: 'job', name: 'sweep-invoices', feature: 'invoice' },
  { kind: 'task', name: 'nightly-sweep', feature: 'invoice' },
  { kind: 'backfill', name: 'reindex-invoices', feature: 'invoice' },
  { kind: 'route', name: 'pricing', surface: 'site' },
  { kind: 'island', name: 'currency-picker', at: 'apps/web/site/pricing' },
  { kind: 'admin:page', name: 'reconcile', permission: 'ledger:reconcile' },
  { kind: 'guard', name: 'migration-safety' },
];

const emitted = (): readonly Emitted[] => [
  ...scaffoldVariants().flatMap((variant) =>
    variant.files.flatMap((file) =>
      typeof file.contents === 'string'
        ? [{ from: variant.name, path: file.path, contents: file.contents }]
        : [],
    ),
  ),
  ...BATTERY.flatMap((options) =>
    generate(options).flatMap((file) =>
      typeof file.contents === 'string'
        ? [
            {
              from: `x g ${options.kind} ${options.name}`,
              path: file.path,
              contents: file.contents,
            },
          ]
        : [],
    ),
  ),
];

/** The paths one invocation writes, so a per-generator assertion names the invocation. */
const pathsOf = (options: GenerateOptions): readonly string[] =>
  generate(options).map((file) => file.path);

describe('unit · a generated test is named for the step it runs under', () => {
  test('every emitted test file is owned by the step its own wrapper declares', () => {
    const offenders = emitted().flatMap((file) => {
      if (!/\.test\.tsx?$/.test(file.path)) return [];
      return wrappersIn(file.contents).flatMap((wrapper) => {
        const expected = STEP_OF_WRAPPER[wrapper];
        return expected === undefined || ownerOf(file.path) === expected
          ? []
          : [
              `${file.from}: ${file.path} calls ${wrapper}() but runs under "${ownerOf(file.path)}"`,
            ];
      });
    });
    expect(offenders).toEqual([]);
  });

  // The mirror of the same bug, and the reason `x g action` emits two files rather than one
  // renamed one: a `unitTest` inside `<name>.contract.test.ts` is a unit test the `unit` step can
  // never select, which is exactly what these generators were doing the other way round.
  test('no emitted test file mixes two steps in one filename', () => {
    const offenders = emitted().flatMap((file) => {
      if (!/\.test\.tsx?$/.test(file.path)) return [];
      const steps = [...new Set(wrappersIn(file.contents).map((name) => STEP_OF_WRAPPER[name]))];
      return steps.length > 1 ? [`${file.from}: ${file.path} mixes ${steps.join(' + ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });
});

// The five, each named — a table failure above says "something drifted", and these say which
// generator and to which filename it must go back.
describe('unit · a generated fixture is torn down only if it was ever set up', () => {
  /**
   * `let mounted: MountedIsland;` is assigned inside `beforeAll`, and TypeScript's
   * definite-assignment analysis does not cross that closure — so the type says "always there" and
   * a rejected setup leaves it `undefined`. bun runs `afterAll` anyway: measured on 1.4.0, a
   * `beforeAll` that throws `X_BUILD_FAILED` reports TWO failures, the coded one and
   * `TypeError: undefined is not an object (evaluating 'mounted[Symbol.dispose]')` — and the
   * TypeError is last, which is what a tailed log shows. Nothing is lost by guarding: `mountIsland`
   * restores the process itself when a mount throws.
   */
  test('a generated afterAll disposes through `?.`, never bare', () => {
    const offenders = emitted().flatMap((file) => {
      if (!/\.test\.tsx?$/.test(file.path)) return [];
      const source = stripComments(file.contents);
      if (!source.includes('beforeAll(')) return [];
      return /(?<!\?\.)\[Symbol\.dispose\]\(/.test(source) ? [`${file.from}: ${file.path}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  test('the rule has subjects, or it is a check over an empty list', () => {
    // Two templates emit one: `x g island` and `x g resource`'s form. A rule whose subject set
    // silently empties passes forever, which is the shape this suite exists to refuse.
    const disposers = emitted().filter(
      (file) => /\.test\.tsx?$/.test(file.path) && file.contents.includes('[Symbol.dispose]('),
    );
    expect(disposers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('unit · each generator writes its test where its own step can select it', () => {
  const target = { surfaceDir: 'apps/web/app', feature: 'invoice' } as const;

  test('x g job and x g task write .job.test.ts', () => {
    expect(pathsOf({ kind: 'job', name: 'sweep-invoices', ...target })).toContain(
      'apps/web/app/invoice/jobs/sweep-invoices.job.test.ts',
    );
    const task = pathsOf({ kind: 'task', name: 'nightly-sweep', ...target });
    expect(task).toContain('apps/web/app/invoice/tasks/nightly-sweep.job.test.ts');
    // `x g task` composes `jobFiles`, so it writes the job's test too — both under `job`.
    expect(task).toContain('apps/web/app/invoice/jobs/nightly-sweep-job.job.test.ts');
  });

  test('x g backfill writes .job.test.ts — a sweep IS a job', () => {
    expect(pathsOf({ kind: 'backfill', name: 'reindex-invoices', ...target })).toContain(
      'apps/web/app/invoice/backfills/reindex-invoices.job.test.ts',
    );
  });

  test('x g query --live writes .live.test.ts, and a one-shot read stays a unit test', () => {
    expect(pathsOf({ kind: 'query', name: 'invoice-feed', live: true, ...target })).toContain(
      'apps/web/app/invoice/live/invoice-feed.live.test.ts',
    );
    expect(pathsOf({ kind: 'query', name: 'invoice-search', ...target })).toContain(
      'apps/web/app/invoice/queries/invoice-search.test.ts',
    );
  });

  // One declaration, two suites: the input parse is a unit test and the contract projection is a
  // contract test, so they cannot share a filename — the filename is what selects the step.
  test('x g action and x g mutator write both files, one per step', () => {
    for (const kind of ['action', 'mutator'] as const) {
      const paths = pathsOf({ kind, name: 'send-invoice', ...target });
      expect([kind, paths.includes('apps/web/app/invoice/actions/send-invoice.test.ts')]).toEqual([
        kind,
        true,
      ]);
      expect([
        kind,
        paths.includes('apps/web/app/invoice/actions/send-invoice.contract.test.ts'),
      ]).toEqual([kind, true]);
    }
  });

  // `x g route` is where this lesson was learned; it must stay learned.
  test('x g route still writes its offline assertion into page.e2e.test.ts', () => {
    expect(pathsOf({ kind: 'route', name: 'pricing', surface: 'site' })).toContain(
      'apps/web/site/pricing/page.e2e.test.ts',
    );
  });
});
