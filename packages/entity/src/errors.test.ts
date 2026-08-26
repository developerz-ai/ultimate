// Where an entity refusal sends its reader. `EntityError` built `https://ultimate.dev/errors/
// <code>` for every code it has ever thrown, and that host answers 404 — so the one link on the
// framework's most-read refusals (`X_DB_DRIFT`, `X_TENANCY_UNSCOPED`) went nowhere.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import { dbDrift as dbPackageDrift } from '@ultimat3/db';
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

/** The tier-1 twin, read through the public barrel — the mirror the comment on both declares. */
const dbFix = (table: string, column: string): string => dbPackageDrift(table, column).fix;
const dbCause = (table: string, column: string): string => dbPackageDrift(table, column).cause;

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

/**
 * `X_DB_DRIFT` is the one refusal this package builds out of a name it did not choose: the column
 * is the CATALOG's, and `x db gen "add C"` puts it inside SHELL DOUBLE QUOTES. Pinned here AND in
 * `@ultimat3/db`'s `drift-errors.test.ts`, because the "keep in sync" comment on both declarations
 * is only true while both are asserted.
 */
describe('dbDrift screens the column it puts in a shell command', () => {
  test('a benign column renders the literal the docs quote, byte for byte', () => {
    expect(dbDrift('posts', 'publish_at').fix).toBe('x db gen "add publish_at"');
  });

  test('a command substitution never reaches the command a human pastes', () => {
    const error = dbDrift('posts', '$(id)');
    expect(error.fix).not.toContain('$(id)');
    expect(error.fix).not.toContain('`');
    expect(error.cause).toContain('$(id)');
  });

  test('a backtick is refused with it', () => {
    expect(dbDrift('posts', '`whoami`').fix).not.toContain('whoami');
  });

  test('the two packages answer with the same text, which is what "keep in sync" claims', () => {
    for (const column of ['publish_at', '$(id)', '`whoami`', 'has"quote', '']) {
      expect(dbDrift('posts', column).fix).toBe(dbFix('posts', column));
      expect(dbDrift('posts', column).cause).toBe(dbCause('posts', column));
    }
  });
});
