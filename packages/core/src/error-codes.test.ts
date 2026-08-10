// Single responsibility: core's own entries in the framework-wide code registry. `errors.test.ts`
// covers the registry's mechanics (duplicates, snapshots, sorting); this file pins the codes core
// declares, because an unregistered code still renders — as a humanised guess nobody wrote.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from './error-codes';

describe('the codes core owns', () => {
  // Core owns this one because core owns the cursor codec, and the title is the only thing
  // standing between `x doctor` reporting a forgeable page position and reporting `cursor secret
  // dev` — the humanised fallback, which reads like a setting rather than a defect.
  test('X_CURSOR_SECRET_DEV is registered, not humanised', () => {
    expect(hasErrorCode('X_CURSOR_SECRET_DEV')).toBe(true);
    expect(describeErrorCode('X_CURSOR_SECRET_DEV').title).toBe(
      'cursors are signed with the shipped development key',
    );
  });
});
