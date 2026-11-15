// A copy of a shipped guard is unedited when it is ANY form the framework shipped — the current
// template, or one a release shipped before (`RELEASED_GUARD_FORMS`) — so a stale copy nobody
// touched is deleted by the migration, and only a real edit is kept as the app's own guard.

import { describe, expect, test } from 'bun:test';
import { guardFormHash, shippedFormSeverity, vendoredCopy } from './guards-vendored';
import { RELEASED_GUARD_FORMS, RELEASED_GUARD_TEST_FORMS } from './templates/guard-released-forms';
import {
  SHIPPED_GUARD_NAMES,
  shippedGuardForms,
  shippedGuardTest,
} from './templates/scaffold-guards';

const OLD =
  "// raw-fetch, as 31.4.0 wrote it\nexport const guard = { summary: 'x', check: () => [] };\n";

describe('unit · a vendored copy, judged against every form the framework shipped', () => {
  test('a form an earlier release shipped is unedited, at the severity it shipped with', () => {
    const released = { 'raw-fetch': [[guardFormHash(OLD), 'warning']] as const };
    expect(shippedFormSeverity('raw-fetch', OLD, released)).toBe('warning');
    expect(shippedFormSeverity('raw-fetch', OLD.replaceAll('\n', '\r\n'), released)).toBe(
      'warning',
    );
    expect(shippedFormSeverity('raw-fetch', `${OLD}// edit\n`, released)).toBeUndefined();
    expect(shippedFormSeverity('raw-colour', OLD, released)).toBeUndefined();
  });

  test('the current template is unedited with no table at all', () => {
    const [current] = shippedGuardForms('raw-fetch');
    expect(shippedFormSeverity('raw-fetch', current?.source ?? '', {})).toBe('error');
  });

  test('an edited copy carries its diff; an unedited one none', () => {
    const [current] = shippedGuardForms('raw-fetch');
    const edited = vendoredCopy('raw-fetch', 'guards/raw-fetch.ts', `${current?.source}// mine\n`);
    expect(edited.identical).toBe(false);
    expect(edited.diff).toContain('+// mine');
    expect(vendoredCopy('raw-fetch', 'guards/raw-fetch.ts', current?.source ?? '')).toEqual({
      name: 'raw-fetch',
      path: 'guards/raw-fetch.ts',
      identical: true,
    });
  });

  // The table is generated from the release tags; a template changed in the tree without
  // regenerating it would make the NEXT release's copies read as edits.
  test('every current form of every shipped guard is in the released-forms table', () => {
    const missing = SHIPPED_GUARD_NAMES.flatMap((name) =>
      shippedGuardForms(name)
        .filter(
          ({ source }) =>
            !(RELEASED_GUARD_FORMS[name] ?? []).some(([hash]) => hash === guardFormHash(source)),
        )
        .map(() => name),
    );
    // bun run scripts/lib/guard-refresh-forms.ts --write regenerates it.
    expect(missing).toEqual([]);
    const untested = SHIPPED_GUARD_NAMES.filter(
      (name) =>
        !(RELEASED_GUARD_TEST_FORMS[name] ?? []).includes(
          guardFormHash(shippedGuardTest(name) ?? ''),
        ),
    );
    expect(untested).toEqual([]);
  });
});
