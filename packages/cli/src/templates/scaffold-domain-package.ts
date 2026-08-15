// The generated app's `packages/domain`: the pure types and constants every other package reads,
// with no I/O of any kind. Split out of scaffold-repo.ts, which was over the file-size ceiling —
// one file per generated workspace package, the seam `scaffold-i18n.ts` already draws.

import type { GeneratedFile, NameSet } from './naming';
import { packageShapeFiles, workspacePackageJson } from './scaffold-package-shape';

const DESCRIPTION = 'Pure types and constants, no I/O';

/** `X_MYAPP_CURRENCY_MISMATCH` — the app's own namespace, so it can never collide with a framework
 * code and `x errors explain` can tell whose it is. */
const currencyCode = (app: NameSet): string =>
  `X_${app.kebab.toUpperCase().split('-').join('_')}_CURRENCY_MISMATCH`;

const domainIndex = (
  app: NameSet,
): string => `// Pure types and constants. No I/O of any kind: no fs, no network, no database, no env reads.
// \`Money\` is @ultimat3/schema's, re-exported and never restated: one declaration of
// { minor, currency } is what makes an entity column, a form field and this module the same type.
import { UltimateError } from '@ultimat3/core';
import type { MoneyValue as Money } from '@ultimat3/schema';

export type { MoneyValue as Money } from '@ultimat3/schema';

export const ROLES = ['owner', 'member', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

/**
 * Never a bare Error: an agent reading the failure needs the code, the cause and the exact command
 * that resolves it. Adding across currencies is a bug in the caller's data, not a runtime hiccup,
 * so the fix names the conversion that has to happen first.
 */
export class ${app.pascal}CurrencyMismatchError extends UltimateError {
  constructor(input: { readonly left: string; readonly right: string }) {
    super({
      code: '${currencyCode(app)}',
      cause: \`cannot add \${input.left} to \${input.right}: Money is only additive inside one currency\`,
      fix: \`bun test packages/domain/src/index.test.ts   # add() is defined only inside one currency — convert \${input.right} to \${input.left} before calling it\`,
      docs: 'https://ultimate.dev/errors/${currencyCode(app)}',
    });
  }
}

export const zero = (currency: string): Money => ({ minor: 0, currency });

export const add = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) {
    throw new ${app.pascal}CurrencyMismatchError({ left: a.currency, right: b.currency });
  }
  return { minor: a.minor + b.minor, currency: a.currency };
};
`;

const domainTest = (app: NameSet): string => `import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { add, ${app.pascal}CurrencyMismatchError, zero } from './index';

unitTest('money adds in minor units', () => {
  expect(add({ minor: 1050, currency: 'USD' }, { minor: 250, currency: 'USD' })).toEqual({
    minor: 1300,
    currency: 'USD',
  });
});

unitTest('money refuses to add across currencies, with a code and a fix', () => {
  expect(() => add(zero('USD'), zero('EUR'))).toThrow(${app.pascal}CurrencyMismatchError);
  try {
    add(zero('USD'), zero('EUR'));
  } catch (error) {
    expect(error).toBeUltimateError('${currencyCode(app)}');
  }
});
`;

/** Every file the `packages/domain` workspace ships, in the order `x new` writes them. */
export const domainPackageFiles = (app: NameSet): readonly GeneratedFile[] => [
  {
    path: 'packages/domain/package.json',
    contents: workspacePackageJson(app, 'domain', DESCRIPTION),
  },
  ...packageShapeFiles(app, 'domain', DESCRIPTION),
  { path: 'packages/domain/src/index.ts', contents: domainIndex(app) },
  { path: 'packages/domain/src/index.test.ts', contents: domainTest(app) },
];
