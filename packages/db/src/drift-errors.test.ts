// `X_DB_DRIFT`'s `fix:` is pasted into a shell, and the column it names is the CATALOG's — so a
// column called `$(id)` used to build a line that runs `id` when its reader pastes it. Both halves
// are pinned here: the benign literal is byte-identical to the one ~ten pages quote, and a hostile
// name never reaches the command at all.

import { describe, expect, test } from 'bun:test';
import { dbDrift } from './drift-errors';
import { unexpectedColumn } from './drift-findings';

describe('dbDrift', () => {
  test('a benign column renders the literal the docs quote, byte for byte', () => {
    // Roughly ten pages across `packages/cli`, `packages/core`, `wiki/` and `docs/` quote this
    // exact string. The screen lives on the refusal branch alone precisely so none of them moves.
    expect(dbDrift('posts', 'publish_at').fix).toBe('x db gen "add publish_at"');
    expect(dbDrift('posts', 'publish_at').cause).toBe(
      'table "posts" has column "publish_at" not present in any migration',
    );
  });

  test('a command substitution never reaches the command a human pastes', () => {
    const error = dbDrift('posts', '$(id)');
    expect(error.fix).not.toContain('$(id)');
    expect(error.fix).not.toContain('`');
    expect(error.fix).toContain('x db gen "add the column named in this error"');
    // Still readable: the name is in the cause and in the meta, which nobody pastes.
    expect(error.cause).toContain('$(id)');
    expect(error.meta).toEqual({ table: 'posts', column: '$(id)' });
  });

  test('a backtick is refused with it — both substitute inside shell double quotes', () => {
    expect(dbDrift('posts', '`whoami`').fix).not.toContain('whoami');
  });

  test('what identifier refuses is out of the command too', () => {
    for (const column of ['has"quote', 'back\\slash', 'two words', '']) {
      expect(dbDrift('posts', column).fix).toContain('the column named in this error');
    }
  });

  /**
   * The same finding through the other channel. The two `cause` lines and the two benign `fix`
   * lines are one wording by contract, and the refusals are deliberately NOT — a reader grepping
   * an emitted line has to land on one site.
   */
  test('the drift REPORT says the same thing, and its refusal is distinguishable', () => {
    expect(unexpectedColumn('posts', 'publish_at').cause).toBe(
      dbDrift('posts', 'publish_at').cause,
    );
    expect(unexpectedColumn('posts', 'publish_at').fix).toBe(dbDrift('posts', 'publish_at').fix);
    expect(unexpectedColumn('posts', '$(id)').fix).not.toBe(dbDrift('posts', '$(id)').fix);
  });
});
