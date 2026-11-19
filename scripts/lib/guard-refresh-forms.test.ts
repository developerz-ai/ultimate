// A released guard form, once recorded, is never dropped by a later `--write`. A tag's templates are
// re-read against the WORKING TREE's `@ultimat3/*` (the workspace links), so a rule that embeds a
// framework value (`undeclared-env` writes core's `FRAMEWORK_ENV` into its text) re-hashes every past
// tag under today's value — and the hash an app's unedited copy actually carries was erased.

import { describe, expect, test } from 'bun:test';
import { withRecorded } from './guard-refresh-forms';

describe('unit · guard-refresh-forms keeps every recorded form', () => {
  test('a recorded hash the regeneration no longer produces stays, with its severity', () => {
    const forms = { 'undeclared-env': new Map([['new', 'error' as const]]) };
    const tests = { 'undeclared-env': new Set(['t-new']) };
    const merged = withRecorded(
      { forms, tests },
      { 'undeclared-env': [['old', 'warning']] },
      { 'undeclared-env': ['t-old'] },
    );
    expect([...(merged.forms['undeclared-env'] ?? [])].sort()).toEqual([
      ['new', 'error'],
      ['old', 'warning'],
    ]);
    expect([...(merged.tests['undeclared-env'] ?? [])].sort()).toEqual(['t-new', 't-old']);
  });

  test('a hash both hold keeps the regenerated severity', () => {
    const merged = withRecorded(
      { forms: { a: new Map([['h', 'error' as const]]) }, tests: {} },
      { a: [['h', 'warning']] },
      {},
    );
    expect([...(merged.forms['a'] ?? [])]).toEqual([['h', 'error']]);
  });

  test('a guard no longer shipped is not carried: the table is per shipped guard', () => {
    const merged = withRecorded({ forms: {}, tests: {} }, { gone: [['h', 'error']] }, {});
    expect(merged.forms).toEqual({});
  });
});
