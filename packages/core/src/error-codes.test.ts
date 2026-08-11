// Single responsibility: core's own entries in the framework-wide code registry. `errors.test.ts`
// covers the registry's mechanics (duplicates, snapshots, sorting); this file pins the codes core
// declares, because an unregistered code still renders — as a humanised guess nobody wrote.

import { afterAll, describe, expect, test } from 'bun:test';
import { describeErrorCode, errorCodeSnapshot, hasErrorCode, resetErrorCodes } from './error-codes';

// The registry is process-global, every package fills it once at import time, and bun shares one
// process across files — so the reset below would strip whatever ran before this file and leave
// their errors rendering the humanised fallback for the rest of the run. Same guard, same reason
// as errors.test.ts: snapshot at module scope, undo in `afterAll`.
const restoreRegistry = errorCodeSnapshot();

afterAll(restoreRegistry);

describe('the codes core owns', () => {
  // Core owns this one because core owns the cursor codec, and the title is the only thing
  // standing between `x doctor` reporting a forgeable page position and reporting `cursor secret
  // dev` — the humanised fallback, which reads like a setting rather than a defect.
  test('X_CURSOR_SECRET_DEV is registered, not humanised', () => {
    // Reset first, so this passes on core's own table rather than on whatever an earlier import
    // happened to register — the claim is ownership, not that something, somewhere, filled it in.
    resetErrorCodes();
    expect(hasErrorCode('X_CURSOR_SECRET_DEV')).toBe(true);
    expect(describeErrorCode('X_CURSOR_SECRET_DEV').title).toBe(
      'cursors are signed with the shipped development key',
    );
  });
});
