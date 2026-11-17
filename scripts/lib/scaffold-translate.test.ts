// The translator stand-in: which values it replaces, with what, and every value it must leave alone.
import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-dir or path API; the fixture app is a real directory on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: as above — the temp root and the catalog paths are spelt the way the host spells them.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCatalogs, standIn, translatedLine, translateSweep } from './scaffold-translate';

const marker = (value: string): string => `⟦${value}⟧`;

describe('unit · scaffold-translate', () => {
  test('a placeholder the sweep wrote becomes "<locale>: <default value>"', () => {
    const after = {
      en: { 'app.a.title': 'Title', 'app.a.body': 'Hello {name}' },
      es: { 'app.a.title': marker('Title'), 'app.a.body': marker('Hello {name}') },
    };
    const result = standIn({ en: {}, es: {} }, after, 'en');
    expect(result.translated).toBe(2);
    expect(result.catalogs).toEqual({
      es: { 'app.a.title': 'es: Title', 'app.a.body': 'es: Hello {name}' },
    });
  });

  test('a placeholder that was there before the sweep is the author’s, and stays', () => {
    const before = { en: { k: 'Value' }, es: { k: marker('Value') } };
    const result = standIn(before, before, 'en');
    expect(result).toEqual({ translated: 0, catalogs: {} });
  });

  test('a real translation, a foreign marker and the default locale are never touched', () => {
    const after = {
      en: { a: 'One', b: 'Two', c: marker('Three') },
      es: { a: 'Uno', b: marker('b'), c: marker('Three') },
    };
    // `b` is `x i18n sync`'s bare-key marker, not the default's value; `c` has no default value.
    expect(standIn({ en: {}, es: {} }, after, 'en')).toEqual({ translated: 0, catalogs: {} });
  });

  test('a single-locale app is a no-op', () => {
    expect(standIn({ en: {} }, { en: { a: marker('a') } }, 'en')).toEqual({
      translated: 0,
      catalogs: {},
    });
  });

  test('on disk: only placeholders written after the snapshot change, nested as the app keeps them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scaffold-translate-'));
    try {
      const catalogs = join(dir, 'packages/i18n/catalogs');
      await Bun.write(
        join(catalogs, 'en.json'),
        JSON.stringify({ app: { old: 'Old', fresh: 'Fresh' } }),
      );
      await Bun.write(join(catalogs, 'es.json'), JSON.stringify({ app: { old: marker('Old') } }));
      const before = await readCatalogs(dir);
      await Bun.write(
        join(catalogs, 'es.json'),
        JSON.stringify({ app: { old: marker('Old'), fresh: marker('Fresh') } }),
      );
      expect(await translateSweep(dir, before)).toBe(1);
      expect(await Bun.file(join(catalogs, 'es.json')).json()).toEqual({
        app: { fresh: 'es: Fresh', old: marker('Old') },
      });
      // The default locale's file is never rewritten.
      expect(await Bun.file(join(catalogs, 'en.json')).text()).toBe(
        JSON.stringify({ app: { old: 'Old', fresh: 'Fresh' } }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an app with no catalog directory reads as no catalogs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scaffold-translate-'));
    try {
      expect(await readCatalogs(dir)).toEqual({});
      expect(await translateSweep(dir, {})).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the pass reports itself as a line, zero included', () => {
    expect(translatedLine(0)).toContain('no generator placeholder');
    expect(translatedLine(3)).toContain('3 generator placeholder(s)');
  });
});
