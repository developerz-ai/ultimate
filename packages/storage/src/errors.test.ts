// Single responsibility: where a storage failure sends its reader. `StorageError` passes no
// `docs:` at all, so the link is whatever the registry resolved for the code — one page, one
// declaration. Pinned against `ERROR_DOCS_URL` rather than a literal, because a hand-copied URL is
// exactly how the dead `https://ultimate.dev/errors/<code>` host survived every suite in the tree.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import {
  diskUnknown,
  objectNotFound,
  STORAGE_ERROR_TITLES,
  STORAGE_OWNED_ERROR_CODES,
  tooLarge,
} from './errors';

describe('unit · every storage code resolves to the one docs page', () => {
  test('a constructed error carries it, and never a per-code URL', () => {
    const errors = [
      diskUnknown('photos', ['uploads']),
      objectNotFound('uploads', 'a/b.png'),
      tooLarge('a/b.png', 10, 5),
    ];
    for (const error of errors) {
      expect(error.docs).toBe(ERROR_DOCS_URL);
      expect(error.docs).not.toContain(error.code);
      expect(error.toJSON().docs).toBe(ERROR_DOCS_URL);
    }
  });

  test('and so does every owned code the registry knows', () => {
    for (const code of STORAGE_OWNED_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(STORAGE_ERROR_TITLES[code]);
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
    }
  });
});
