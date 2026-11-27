import { describe, expect, test } from 'bun:test';
import { readPinTables } from '../finished-reads';
import { ADVISORY_ACKNOWLEDGED } from './advisory-acknowledged';
import { SCRIPT_PIN_TABLES, scriptTableRows } from './pin-tables';

// The ledger is read by string comparison against a `YYYY-MM-DD` day, so a row's shape is the
// difference between an expiry that fires and one that never does.

describe('ADVISORY_ACKNOWLEDGED', () => {
  test.each(ADVISORY_ACKNOWLEDGED.map((row) => [`${row.manifest} ${row.dependency}`, row]))(
    '%s is a row the audit can read',
    async (_name, row) => {
      // A real calendar day: `2027-02-30` would compare as a date and never be one.
      expect(row.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${row.expires}T00:00:00Z`).toISOString().slice(0, 10)).toBe(row.expires);
      expect(row.advisories.length).toBeGreaterThan(0);
      for (const id of row.advisories) expect(id).toMatch(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
      expect(row.reason.trim()).not.toBe('');
      // The app's fix updates exactly the packages the advisories are in.
      expect(row.appFix).toBe(['bun', 'update', ...row.via].join(' '));
      const manifest: unknown = await Bun.file(`${import.meta.dir}/../../${row.manifest}`).json();
      expect(manifest).toMatchObject({ dependencies: { [row.dependency]: expect.any(String) } });
    },
  );

  test('one row per declaration, so an expiry is never shadowed by a second row', () => {
    const keys = ADVISORY_ACKNOWLEDGED.map((row) => `${row.manifest} ${row.dependency}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the ledger is a ratchet', () => {
  const spec = SCRIPT_PIN_TABLES.find((one) => one.table === 'ADVISORY_ACKNOWLEDGED');

  test('finished counts it: an acknowledgement is exemption debt, reasoned or red', async () => {
    const tables = await readPinTables(`${import.meta.dir}/../..`);
    expect(tables.map((one) => `${one.path} ${one.table}`)).toContain(
      'scripts/lib/advisory-acknowledged.ts ADVISORY_ACKNOWLEDGED',
    );
  });

  test('pin-raises reads a row per declaration and expiry, worth its advisories', () => {
    expect(spec?.path).toBe('scripts/lib/advisory-acknowledged.ts');
    const row = { ...ADVISORY_ACKNOWLEDGED[0], advisories: ['GHSA-a', 'GHSA-b'] };
    const rows =
      spec === undefined ? new Map() : scriptTableRows(spec, { ADVISORY_ACKNOWLEDGED: [row] });
    // Re-dating a row is a new key, and a new key is a raise: an extension needs its own why:.
    expect([...rows]).toEqual([
      [`ADVISORY_ACKNOWLEDGED.${row.manifest} ${row.dependency} until ${row.expires}`, 2],
    ]);
  });

  test('a row is placed on its dependency line, so a raise names the line to reason', async () => {
    const source = await Bun.file(`${import.meta.dir}/advisory-acknowledged.ts`).text();
    const first = ADVISORY_ACKNOWLEDGED[0];
    const key = `ADVISORY_ACKNOWLEDGED.${first?.manifest} ${first?.dependency} until ${first?.expires}`;
    const line = spec?.line?.(source, key) ?? 0;
    expect(source.split('\n')[line - 1]).toContain(`dependency: '${first?.dependency}'`);
  });
});
