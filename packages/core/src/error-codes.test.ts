// Single responsibility: core's own entries in the framework-wide code registry. `errors.test.ts`
// covers the registry's mechanics (duplicates, snapshots, sorting); this file pins the codes core
// declares, because an unregistered code still renders — as a humanised guess nobody wrote.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  describeErrorCode,
  ERROR_DOCS_URL,
  errorCodeSnapshot,
  hasErrorCode,
  resetErrorCodes,
} from './error-codes';

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

describe('ERROR_DOCS_URL', () => {
  // `https://ultimate.dev/errors/<code>` answered 404 on every error the framework has ever
  // thrown, including the first line a new agent reads. `wiki/` is the only public documentation
  // surface there is, and codes live in TABLE ROWS there — so there is no per-code anchor, and a
  // per-code fragment would be a second dead declaration rather than a fix for the first.
  test('is the wiki page, with no per-code fragment to be dead', () => {
    expect(ERROR_DOCS_URL).toBe('https://github.com/developerz-ai/ultimate/wiki/Error-Codes');
    expect(ERROR_DOCS_URL).not.toContain('ultimate.dev');
    expect(ERROR_DOCS_URL).not.toContain('#');
  });

  test('every code core declares points at it, and none carries a dead host', () => {
    resetErrorCodes();
    for (const code of ['X_ABORTED', 'X_CONFIG_INVALID', 'X_INTERNAL', 'X_TIMEOUT']) {
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
    }
    // A code nobody registered gets the humanised fallback, and its docs must not be dead either.
    expect(describeErrorCode('X_NOBODY_REGISTERED_THIS').docs).toBe(ERROR_DOCS_URL);
  });
});
