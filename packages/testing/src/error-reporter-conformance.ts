// The `errorReporter` port's contract as shared examples: `behavesLike(errorReporterConformance,
// () => ({ reporter, delivered }))`. `report()` runs inside every failure path's catch, so it may
// not throw, may not make the caller wait, and — unless it is a marked local sink — may not carry a
// secret off the box. `delivered()` is the text each report left as (an envelope, a row, a line).

import { expect, test } from 'bun:test';
import type { ErrorReport } from '@ultimat3/core';
import { errorReport, isLocalErrorSink, UltimateError } from '@ultimat3/core';
import type { ErrorReporter } from '@ultimat3/core/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface ErrorReporterSubject {
  readonly reporter: ErrorReporter;
  /** What left the reporter so far, one string per delivered report, in order. */
  delivered(): readonly string[];
}

export interface ErrorReporterCheck {
  readonly name: string;
  run(subject: ErrorReporterSubject): Promise<void>;
}

const SECRET = 'hunter2-conformance-secret';

/**
 * The registered code every conformance report carries — a suite invents no code of its own — so
 * one report is told from another by its `cause`, which names `label`.
 */
const CODE = 'X_INVARIANT';
/** A runnable fix, opening with the command: what whoever is paged pastes. */
const FIX = 'bun test ./packages/testing/src/error-reporter-conformance.test.ts';

const causeOf = (label: string): string => `${label} happened during the conformance run`;

/** A report built the way `reportError` builds one, for a coded failure labelled `label`. */
export function conformanceReport(
  label: string,
  meta: Readonly<Record<string, unknown>> = {},
  extra: Readonly<Record<string, unknown>> = {},
): ErrorReport {
  const error = new UltimateError({
    code: CODE,
    cause: causeOf(label),
    fix: FIX,
    meta,
  });
  return errorReport(error, { source: 'http', scope: { operation: 'GET /orders', extra } });
}

/** A `meta` no naive serialiser survives: a bigint, a cycle, and a getter that throws. */
function hostileMeta(): Record<string, unknown> {
  const cycle: Record<string, unknown> = { name: 'cycle' };
  cycle['self'] = cycle;
  const meta: Record<string, unknown> = { big: 10n ** 30n, cycle };
  Object.defineProperty(meta, 'exploding', {
    enumerable: true,
    // A lazily parsed field whose source is corrupt: the throw a real getter makes.
    get: (): unknown => JSON.parse('{ not json'),
  });
  return meta;
}

export const ERROR_REPORTER_CHECKS: readonly ErrorReporterCheck[] = [
  {
    name: 'report() answers nothing, synchronously: the caller never waits on the monitor',
    async run({ reporter }) {
      const answered: unknown = reporter.report(conformanceReport('sync'));
      expect(answered).toBeUndefined();
    },
  },
  {
    name: 'every report is delivered once, carrying its code, cause and runnable fix',
    async run({ reporter, delivered }) {
      const before = delivered().length;
      reporter.report(conformanceReport('first'));
      reporter.report(conformanceReport('second'));
      const sent = delivered().slice(before);
      expect(sent).toHaveLength(2);
      for (const [text, label] of [
        [sent[0] ?? '', 'first'],
        [sent[1] ?? '', 'second'],
      ] as const) {
        expect(text).toContain(CODE);
        expect(text).toContain(causeOf(label));
        expect(text).toContain(FIX);
      }
    },
  },
  {
    name: 'a meta holding a bigint, a cycle and a throwing getter never throws into the caller',
    async run({ reporter }) {
      const report = conformanceReport('hostile', hostileMeta());
      expect(() => reporter.report(report)).not.toThrow();
    },
  },
  {
    name: 'a reporter that is not a marked local sink carries no secret off the box',
    async run({ reporter, delivered }) {
      const before = delivered().length;
      reporter.report(conformanceReport('secret', { password: SECRET }, { token: SECRET }));
      const sent = delivered().slice(before).join('\n');
      expect(sent).toContain(causeOf('secret'));
      // A local sink keeps the report on the box, whole — what it holds is the process's own.
      if (!isLocalErrorSink(reporter)) expect(sent).not.toContain(SECRET);
    },
  },
];

export const errorReporterConformance: SharedExamples<ErrorReporterSubject> = sharedExamples(
  'an error reporter',
  (subject) => {
    for (const check of ERROR_REPORTER_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
