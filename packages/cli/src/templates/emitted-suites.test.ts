// A generated test runs under the gate step its FILENAME picks, and the wrapper it calls declares
// which step that has to be. Five generators disagreed with themselves: `x test contract`,
// `x test live` and `x test job` all answered X_TEST_NO_FILES in an app that shipped all three
// kinds of test, because every one of them was written as a plain `<name>.test.ts` and classified
// as a unit test. `x g route` learned this lesson alone (`route.test.ts`); this is it, generalised.

import { describe, expect, test } from 'bun:test';
import { stripComments } from '@ultimat3/core';
import type { GenerateOptions } from '../cmd-generate';
import { generate } from '../cmd-generate';
import { scaffoldVariants } from '../scaffold-fixture';
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
describe('unit · a generated island test holds no mount by hand', () => {
  const islandTests = (): readonly Emitted[] =>
    emitted().filter((file) => file.path.endsWith('.island.test.ts'));

  /**
   * A mount installs a process-global `document`, so a test that holds one owes a `beforeAll`, an
   * `afterAll`, a `?.` on the disposer (a setup that rejected leaves the binding undefined and bun
   * runs `afterAll` anyway) and a hand-rolled lookup of the state it mounts. Every generator wrote
   * all four, per state. `describeIslandState` owns them now, so an emitted test that reaches for
   * the raw pieces is the boilerplate coming back.
   */
  test('every one goes through describeIslandState, and none through the raw pieces', () => {
    const offenders = islandTests().flatMap((file) => {
      const source = stripComments(file.contents);
      const raw = ['mountIsland(', 'beforeAll(', 'afterAll(', '[Symbol.dispose]'].filter((piece) =>
        source.includes(piece),
      );
      const missing = source.includes('describeIslandState(') ? [] : ['no describeIslandState'];
      return [...raw, ...missing].map((what) => `${file.from}: ${file.path} — ${what}`);
    });
    expect(offenders).toEqual([]);
  });

  test('the rule has subjects, or it is a check over an empty list', () => {
    // `x g island`, `x g resource`'s form, and the scaffold's own two: the example slice's form
    // and the theme toggle. A rule whose subject set silently empties passes forever, which is
    // the shape this suite exists to refuse.
    const paths = new Set(islandTests().map((file) => file.path.split('/').at(-1)));
    expect([...paths].sort()).toEqual([
      'currency-picker.island.test.ts',
      'invoice-form.island.test.ts',
      'post-form.island.test.ts',
      'theme-toggle.island.test.ts',
    ]);
  });
});

describe('unit · a generated route file exports its component as Page', () => {
  // The router looks for `Page` first and both tracked apps spell it so; `x g route` wrote
  // `PostsPage` and the scaffold `DashboardPage`, found only through the router's fallback.
  test('every emitted page.tsx exports exactly one component, named Page', () => {
    const pages = emitted().filter((file) => /(^|\/)page\.tsx$/.test(file.path));
    expect(pages.length).toBeGreaterThanOrEqual(4);
    const offenders = pages.flatMap((file) => {
      const exported = [
        ...stripComments(file.contents).matchAll(/^export (?:async )?function ([A-Z]\w*)/gm),
      ];
      const names = exported.map((match) => match[1]);
      return names.length === 1 && names[0] === 'Page'
        ? []
        : [`${file.from}: ${file.path} exports ${names.join(', ') || 'no component'}`];
    });
    expect(offenders).toEqual([]);
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

// An app's coverage floor counts the `unit` suite alone, over every source file — one nothing in
// that suite loads counts at 0%. So each generator that writes source writes a UNIT test that
// imports it, whatever other suite its guarantees belong to.
describe('unit · each generator writes a unit test that loads the source it wrote', () => {
  const target = { surfaceDir: 'apps/web/app', feature: 'invoice' } as const;

  /** The emitted file at `path`, or a failure naming it — never an empty string that matches nothing. */
  const contentsAt = (options: GenerateOptions, path: string): string => {
    const file = generate(options).find((one) => one.path === path);
    if (file === undefined || typeof file.contents !== 'string') {
      return expect.unreachable(`x g ${options.kind} ${options.name} writes no ${path}`);
    }
    expect(ownerOf(path)).toBe('unit');
    return file.contents;
  };

  test('x g job: the body runs under a worker in the unit suite', () => {
    const unit = contentsAt(
      { kind: 'job', name: 'sweep-invoices', ...target },
      'apps/web/app/invoice/jobs/sweep-invoices.test.ts',
    );
    expect(unit).toContain("import { sweepInvoices } from './sweep-invoices';");
    expect(unit).toContain('await runJobs(sweepInvoices, {');
  });

  test('x g task: firing it runs in the unit suite, and so does the job it composes', () => {
    const options = { kind: 'task', name: 'nightly-sweep', ...target } as const;
    const unit = contentsAt(options, 'apps/web/app/invoice/tasks/nightly-sweep.test.ts');
    expect(unit).toContain('await nightlySweep.enqueue()');
    expect(unit).toContain('await runJobs.drain()');
    expect(contentsAt(options, 'apps/web/app/invoice/jobs/nightly-sweep-job.test.ts')).toContain(
      'await runJobs(nightlySweepJob, {',
    );
  });

  test('x g backfill: one whole pass runs in the unit suite', () => {
    const unit = contentsAt(
      { kind: 'backfill', name: 'reindex-invoices', ...target },
      'apps/web/app/invoice/backfills/reindex-invoices.test.ts',
    );
    expect(unit).toContain('await runJobs(reindexInvoices, {})');
  });

  test('x g query --live: the read executes in the unit suite, beside the live file', () => {
    const unit = contentsAt(
      { kind: 'query', name: 'invoice-feed', live: true, ...target },
      'apps/web/app/invoice/live/invoice-feed.test.ts',
    );
    expect(unit).toContain("import { invoiceFeed } from './invoice-feed';");
    expect(unit).toContain('await target.as(member, {');
    // And a one-shot read carries the same cases in the one file it already has.
    const oneShot = contentsAt(
      { kind: 'query', name: 'invoice-search', ...target },
      'apps/web/app/invoice/queries/invoice-search.test.ts',
    );
    expect(oneShot).toContain('await target.as(member, {');
  });

  test('x g route: the page is rendered, not only its config read', () => {
    const unit = contentsAt(
      { kind: 'route', name: 'pricing', surface: 'site' },
      'apps/web/site/pricing/page.test.ts',
    );
    expect(unit).toContain("import * as page from './page';");
    expect(unit).toContain('await renderRoute(page, request)');
  });

  test('x g island and the resource form: the island test mounts every declared state', () => {
    const island = contentsAt(
      { kind: 'island', name: 'currency-picker', at: 'apps/web/site/pricing' },
      'apps/web/site/pricing/currency-picker.island.test.ts',
    );
    expect(island).toContain("from './currency-picker.island.states';");
    const form = contentsAt(
      { kind: 'resource', name: 'invoice' },
      'apps/web/app/invoice/invoice-form.island.test.ts',
    );
    expect(form).toContain("from './invoice-form.island.states';");
    // One block per state the generator declared — read off the states file it wrote, so a third
    // declared state with no block is a failure here rather than a state nobody mounts.
    const statesOf = (options: GenerateOptions, path: string): readonly string[] =>
      [...contentsAt(options, path).matchAll(/^\s+id: '([a-z-]+)',$/gm)].map(
        (match) => match[1] ?? '',
      );
    const pairs = [
      {
        spec: island,
        ids: statesOf(
          { kind: 'island', name: 'currency-picker', at: 'apps/web/site/pricing' },
          'apps/web/site/pricing/currency-picker.island.states.ts',
        ),
        manifest: 'currencyPickerStates',
      },
      {
        spec: form,
        ids: statesOf(
          { kind: 'resource', name: 'invoice' },
          'apps/web/app/invoice/invoice-form.island.states.ts',
        ),
        manifest: 'invoiceFormStates',
      },
    ];
    for (const { spec, ids, manifest } of pairs) {
      expect(ids.length).toBeGreaterThanOrEqual(2);
      for (const id of ids) {
        expect(spec).toContain(`describeIslandState(${manifest}, '${id}', island, (mounted) => {`);
      }
    }
  });
});
