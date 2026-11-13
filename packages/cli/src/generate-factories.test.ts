// Every primitive factory the framework ships answers `x g`: a generator that emits its one call,
// or a stated reason there is none. A new `PRIMITIVE_FACTORIES` row with neither fails here, so
// "an agent can scaffold it" is a decision someone made, never a gap nobody noticed.

import { describe, expect, test } from 'bun:test';
import { PRIMITIVE_FACTORIES } from '@ultimat3/core';
import { FACTORY_GENERATORS } from './generate-factories';
import { generate } from './generate-files';
import { GENERATORS } from './generate-kinds';

const generators: readonly string[] = GENERATORS;

describe('unit · x g · one row per primitive factory', () => {
  test('every PRIMITIVE_FACTORIES row has a generator or a reason, and no row is extra', () => {
    const shipped = PRIMITIVE_FACTORIES.map((row) => row.factory).toSorted();
    expect(FACTORY_GENERATORS.map((row) => row.factory).toSorted()).toEqual(shipped);
  });

  test('a generator named is one `x g` reaches; a reason is a sentence, not a placeholder', () => {
    for (const row of FACTORY_GENERATORS) {
      if ('generator' in row)
        expect([row.factory, generators.includes(row.generator)]).toEqual([row.factory, true]);
      else expect([row.factory, row.none.length > 40]).toEqual([row.factory, true]);
    }
  });

  test('each generator emits the one call of its factory, imported from its package', () => {
    for (const row of FACTORY_GENERATORS) {
      if (!('generator' in row)) continue;
      const pkg = PRIMITIVE_FACTORIES.find((one) => one.factory === row.factory)?.pkg ?? '';
      const files = generate({ kind: row.generator, name: 'nightly-sweep', feature: 'ops' });
      const source = files.find((file) => file.path.endsWith('/nightly-sweep.ts'));
      const text = String(source?.contents ?? '');
      expect([row.factory, text.includes(`${row.factory}({`)]).toEqual([row.factory, true]);
      expect([
        row.factory,
        new RegExp(`import \\{[^}]*\\b${row.factory}\\b[^}]*\\} from '${pkg}'`).test(text),
      ]).toEqual([row.factory, true]);
    }
  });

  test('the four factories x g writes, by name', () => {
    expect(
      FACTORY_GENERATORS.filter((row) => 'generator' in row).map((row) => row.factory),
    ).toEqual(['backfill', 'cronJob', 'purge', 'webhookReceiver']);
  });

  // A draw cannot sign a vendor event, and `payload` is free JSON the handler trusts verified: the
  // receiver's job is reached in `x exercise` only through the entry the generator declares.
  test('x g webhook-receiver declares its job an exercise entry with a verified-shape event', () => {
    const files = generate({ kind: 'webhook-receiver', name: 'billing-events', feature: 'ops' });
    const entries = files.flatMap((file) =>
      'exercise' in file && file.exercise !== undefined ? [file.exercise] : [],
    );
    expect(entries.map((entry) => entry.name)).toEqual(['billing-events']);
    expect(entries[0]?.value).toContain("payload: { id: 'evt_exercise', type: 'thing.happened' }");
  });
});
