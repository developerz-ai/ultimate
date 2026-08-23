// Where an entity refusal sends its reader. `EntityError` built `https://ultimate.dev/errors/
// <code>` for every code it has ever thrown, and that host answers 404 — so the one link on the
// framework's most-read refusals (`X_DB_DRIFT`, `X_TENANCY_UNSCOPED`) went nowhere.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import {
  dbDrift,
  ENTITY_ERROR_TITLES,
  ENTITY_OWNED_ERROR_CODES,
  type EntityError,
  entityDuplicate,
  invariantViolated,
  notFound,
  repoClientPinned,
  tenancyUnscoped,
} from './errors';

/** One instance per shape, so the assertion is about the CLASS and not about one factory. */
const instances = (): readonly EntityError[] => [
  entityDuplicate('posts', 'posts'),
  invariantViolated('posts', 'title_present', 'is required'),
  tenancyUnscoped('posts', 'orgId'),
  notFound('posts', '00000000-0000-7000-8000-000000000001'),
  repoClientPinned('posts'),
  dbDrift('posts', 'archived_at'),
];

describe('error code registry', () => {
  test('every owned code is registered with its declared title', () => {
    for (const code of ENTITY_OWNED_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(ENTITY_ERROR_TITLES[code]);
    }
  });
});

describe('every entity error documents at the one page core declares', () => {
  // Asserted on an INSTANCE, never only through `describeErrorCode`: the registry answered
  // correctly the whole time this class was overriding `docs:` with a dead per-code URL, so a
  // registry-only test could not have seen the defect at all.
  test('the constructed error carries core’s constant, with no per-code fragment', () => {
    for (const error of instances()) {
      expect(error.docs).toBe(ERROR_DOCS_URL);
      // There is ONE page and codes live on it in table rows, which have no anchor.
      expect(error.docs).not.toContain(error.code);
      expect(error.docs).not.toContain('ultimate.dev');
      expect(error.docs).not.toContain('#');
    }
  });

  test('the JSON an agent reads carries the same link', () => {
    // `--json` is a separate renderer from `.docs`, and it is the one an agent reads first.
    for (const error of instances()) {
      expect(JSON.parse(JSON.stringify(error.toJSON()))['docs']).toBe(ERROR_DOCS_URL);
    }
  });
});
