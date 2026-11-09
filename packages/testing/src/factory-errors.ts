// The factory lint's one refusal. Its own file because `errors.ts` is another owner's; the code is
// registered there (`TESTING_ERROR_CODES`) and documented in `wiki/Error-Codes.md`.

import { UltimateError } from '@ultimat3/core';

/** One factory, one trait (or none), one strategy that produced a row its entity refuses. */
export interface FactoryFinding {
  readonly factory: string;
  /** `null` for the factory with no trait applied. */
  readonly trait: string | null;
  readonly strategy: 'build' | 'create';
  /** The entity's own code when it refused the row; `X_TEST_FACTORY_INVALID` for an unknown column. */
  readonly code: string;
  readonly cause: string;
}

const label = (finding: FactoryFinding): string =>
  `${finding.factory}${finding.trait === null ? '' : `.with('${finding.trait}')`}.${finding.strategy}()`;

/**
 * A factory that builds a row its own entity refuses fails every test that uses it, one at a time
 * and far from the cause. The lint names each one at once, with the entity's own reason.
 */
export class FactoryInvalidError extends UltimateError {
  readonly findings: readonly FactoryFinding[];

  constructor(findings: readonly [FactoryFinding, ...FactoryFinding[]]) {
    const [first] = findings;
    super({
      code: 'X_TEST_FACTORY_INVALID',
      cause: `${findings.length} factory row(s) the entity refuses: ${findings
        .map((finding) => `${label(finding)} — ${finding.code}: ${finding.cause}`)
        .join('; ')}`,
      fix: `defineFactory(<the entity>, { defaults, traits }) — edit the defaults or trait behind ${label(first)} so its row is one the entity stores, then re-run assertFactoriesValid(…)`,
    });
    this.findings = findings;
  }
}
