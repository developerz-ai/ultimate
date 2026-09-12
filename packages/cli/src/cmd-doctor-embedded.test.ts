// The embedded-database half of `x doctor`, split out of `cmd-doctor.test.ts` under the 500-line
// ceiling: the rule is pure, and the probe reaches a real module resolver, so neither case needs
// the whole-report stub the other file is built around.

import { describe, expect, test } from 'bun:test';
import { PGLITE_FIX, PGLITE_MISSING, PGLITE_PACKAGE } from '@ultimat3/db';
import { REQUIRED_BUN } from './app-root';
import { embeddedDatabaseFinding, probeFor } from './cmd-doctor';

describe('unit · x doctor · the embedded database rule', () => {
  // The bare-VM hole, and the reason it stayed open: `probeDatabase` answers `null` with no
  // DATABASE_URL, so the one configuration a dz-runner box actually has was the one configuration
  // `x doctor` said nothing about. `bin/setup` reported it instead, four commands later.
  test('a selected-but-unresolvable embedded database is red, in @ultimat3/db own words', () => {
    const found = embeddedDatabaseFinding({ selected: true, resolved: false });
    expect(found?.code).toBe('X_DB_UNAVAILABLE');
    expect(found?.cause).toContain(PGLITE_MISSING);
    // "unset or blank", never "unset": `externalUrl` reads a whitespace-only value as no database
    // too, and a cause is a stable diagnostic a reader greps — one that called a SET variable unset
    // would send them looking for a variable they had already exported.
    expect(found?.cause).toContain('DATABASE_URL is unset or blank');
    // The package's own runnable line, not a second wording for one condition.
    expect(found?.fix).toBe(PGLITE_FIX);
  });

  // An app pointed at a real Postgres never loads PGlite, so an absent optional peer there is not
  // a defect: `probeDatabase` owns that configuration, and a second finding about it is noise.
  test('every other combination of the two facts is silent', () => {
    for (const fact of [
      { selected: true, resolved: true },
      { selected: false, resolved: true },
      { selected: false, resolved: false },
    ]) {
      expect(embeddedDatabaseFinding(fact)).toBeUndefined();
    }
  });
});

describe('unit · x doctor · probeFor reads the embedded database without opening it', () => {
  // A RESOLVE and not an import: booting PGlite costs seconds and takes the single-writer lock the
  // next command needs, so a diagnostic that loaded it would be the reason `x dev` then could not.
  // This repository declares `@electric-sql/pglite` in its root manifest, so the answer is the
  // installed one.
  test('the peer is resolved, never loaded, and DATABASE_URL decides `selected`', async () => {
    const fact = await probeFor(import.meta.dir, REQUIRED_BUN, 3000).embeddedDatabase();
    expect(fact.resolved).toBe(true);
    expect(fact.selected).toBe((process.env['DATABASE_URL'] ?? '').trim() === '');
    // The specifier the probe asks about is the package's own, so a rename cannot leave the probe
    // resolving a name nothing publishes.
    expect(PGLITE_PACKAGE).toBe('@electric-sql/pglite');
  });

  // A SET variable holding only whitespace is not a database, and `x db migrate` on it fails the
  // same way an unset one does — so the probe reads it the same way, and the cause above says
  // "unset or blank" rather than describing a variable the reader has already exported.
  test('a whitespace-only DATABASE_URL selects the embedded database, like an unset one', async () => {
    const before = process.env['DATABASE_URL'];
    try {
      process.env['DATABASE_URL'] = '   ';
      expect(
        (await probeFor(import.meta.dir, REQUIRED_BUN, 3000).embeddedDatabase()).selected,
      ).toBe(true);
      process.env['DATABASE_URL'] = 'postgres://user@localhost:5432/app';
      expect(
        (await probeFor(import.meta.dir, REQUIRED_BUN, 3000).embeddedDatabase()).selected,
      ).toBe(false);
    } finally {
      if (before === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = before;
    }
  });
});
