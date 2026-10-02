// Single responsibility: `PgliteOptions.extensions` — which bundle a Postgres extension name
// resolves to, that the name cannot leave `contrib/`, and that a boot naming none is unchanged.

import { describe, expect, test } from 'bun:test';
import { DbError } from './errors';
import { loadPgliteDriver, type PgliteDriver } from './pglite';
import { linkPgliteExtensions, pgliteExtensionExport } from './pglite-extensions';
import { PGLITE_PACKAGE } from './pglite-package';

/** What Bun's `import()` rejects with for a path nothing ships — input, not a verdict. */
const notShipped = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' }));

const driver: PgliteDriver = {
  query: async () => ({ rows: [] }),
  close: async () => undefined,
};

/** A `PGlite` constructor that records the options it was handed. */
function recordingModule(seen: unknown[]): { PGlite: new (...args: unknown[]) => PgliteDriver } {
  return {
    PGlite: class {
      constructor(_dataDir: unknown, options: unknown) {
        seen.push(options);
        // biome-ignore lint/correctness/noConstructorReturn: the fake hands back one shared driver
        return driver;
      }
    } as unknown as new (
      ...args: unknown[]
    ) => PgliteDriver,
  };
}

describe('pgliteExtensionExport', () => {
  test('a Postgres name is its bundle’s export; a dash becomes an underscore', () => {
    expect(pgliteExtensionExport('citext')).toBe('citext');
    expect(pgliteExtensionExport('uuid-ossp')).toBe('uuid_ossp');
  });

  test('a name that could leave contrib/ resolves to nothing', () => {
    expect(pgliteExtensionExport('../../index')).toBeUndefined();
    expect(pgliteExtensionExport('a/b')).toBeUndefined();
    expect(pgliteExtensionExport('')).toBeUndefined();
    expect(pgliteExtensionExport('Citext')).toBeUndefined();
  });
});

describe('loadPgliteDriver · extensions', () => {
  test('each named extension is loaded from contrib/ and handed to the constructor', async () => {
    const seen: unknown[] = [];
    const specifiers: string[] = [];
    await loadPgliteDriver({
      load: async () => recordingModule(seen),
      extensions: ['citext', 'uuid-ossp'],
      loadExtension: async (specifier) => {
        specifiers.push(specifier);
        return { citext: { name: 'citext' }, uuid_ossp: { name: 'uuid-ossp' } };
      },
    });
    expect(specifiers).toEqual([
      `${PGLITE_PACKAGE}/contrib/citext`,
      `${PGLITE_PACKAGE}/contrib/uuid_ossp`,
    ]);
    expect(seen[0]).toMatchObject({
      extensions: { citext: { name: 'citext' }, uuid_ossp: { name: 'uuid-ossp' } },
    });
  });

  test('a bundle nothing ships, and a name that is not one, are skipped — never a failed boot', async () => {
    const seen: unknown[] = [];
    await loadPgliteDriver({
      load: async () => recordingModule(seen),
      extensions: ['postgis', '../../evil'],
      loadExtension: notShipped,
    });
    expect(seen[0]).not.toHaveProperty('extensions');
  });

  test('the list may be a function: a client is built before its migrations are read', async () => {
    const seen: unknown[] = [];
    await loadPgliteDriver({
      load: async () => recordingModule(seen),
      extensions: async () => ['citext'],
      loadExtension: async () => ({ citext: { name: 'citext' } }),
    });
    expect(seen[0]).toMatchObject({ extensions: { citext: { name: 'citext' } } });
  });

  test('a boot that names no extension hands PGlite exactly what it always did', async () => {
    const seen: unknown[] = [];
    await loadPgliteDriver({ load: async () => recordingModule(seen) });
    expect(Object.keys(seen[0] as object)).toEqual(['parsers']);
  });
});

describe('linkPgliteExtensions', () => {
  const shipped = (bundles: Readonly<Record<string, unknown>>) => {
    const asked: string[] = [];
    const load = (specifier: string): Promise<unknown> => {
      asked.push(specifier);
      return Object.hasOwn(bundles, specifier) ? Promise.resolve(bundles[specifier]) : notShipped();
    };
    return { asked, load };
  };

  test('what resolves is linked; what does not is named as missing, sorted', async () => {
    const { load } = shipped({
      [`${PGLITE_PACKAGE}/contrib/citext`]: { citext: 'c' },
      [`${PGLITE_PACKAGE}/contrib/uuid_ossp`]: { uuid_ossp: 'u' },
    });
    expect(await linkPgliteExtensions(['uuid-ossp', 'postgis', 'citext', 'h3'], load)).toEqual({
      linked: { uuid_ossp: 'u', citext: 'c' },
      missing: ['h3', 'postgis'],
    });
  });

  test('an extension outside contrib is found at the package root, asked second', async () => {
    const { asked, load } = shipped({ [`${PGLITE_PACKAGE}/vector`]: { vector: 'v' } });
    expect(await linkPgliteExtensions(['vector'], load)).toEqual({
      linked: { vector: 'v' },
      missing: [],
    });
    expect(asked).toEqual([`${PGLITE_PACKAGE}/contrib/vector`, `${PGLITE_PACKAGE}/vector`]);
  });

  test('an installed bundle that fails to evaluate is that failure, never `missing`', async () => {
    const broken = (): Promise<never> =>
      Promise.reject(new SyntaxError('Unexpected token in contrib/citext.js'));
    const refusal = await linkPgliteExtensions(['citext'], broken).then(
      () => expect.unreachable('a bundle that throws must not read as absent'),
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DbError);
    const error = refusal as DbError;
    expect(error.code).toBe('X_DB_UNAVAILABLE');
    expect(error.cause).toContain('citext');
    expect(error.cause).toContain('Unexpected token in contrib/citext.js');
    expect(error.fix).toStartWith('bun install --force');
  });

  test('plpgsql is compiled in: never loaded, never missing', async () => {
    const { asked, load } = shipped({});
    expect(await linkPgliteExtensions(['plpgsql'], load)).toEqual({ linked: {}, missing: [] });
    expect(asked).toEqual([]);
  });

  test('a name that could leave the package never reaches the loader, and is missing', async () => {
    const { asked, load } = shipped({});
    expect((await linkPgliteExtensions(['../../evil'], load)).missing).toEqual(['../../evil']);
    expect(asked).toEqual([]);
  });

  test('a package entry point that is not an extension is not linked as one', async () => {
    // `@electric-sql/pglite/live` exports `live`, a PGlite plugin PGlite would happily accept.
    const { asked, load } = shipped({ [`${PGLITE_PACKAGE}/live`]: { live: 'plugin' } });
    expect((await linkPgliteExtensions(['live'], load)).missing).toEqual(['live']);
    expect(asked).toEqual([`${PGLITE_PACKAGE}/contrib/live`]);
  });

  test('the installed PGlite: every contrib bundle it ships resolves, and vector is not one', async () => {
    // The real loader, no boot. This is the fact the engine rule in `@ultimat3/cli` stands on.
    const real = await linkPgliteExtensions([
      'citext',
      'pgcrypto',
      'uuid-ossp',
      'pg_trgm',
      'vector',
    ]);
    expect(Object.keys(real.linked).sort()).toEqual(['citext', 'pg_trgm', 'pgcrypto', 'uuid_ossp']);
    expect(real.missing).toEqual(['vector']);
  });
});
