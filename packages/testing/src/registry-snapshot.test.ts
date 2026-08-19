import { describe, expect, test } from 'bun:test';
import { flattenCatalog } from '../../i18n/src/catalog';
import {
  catalogFor,
  configureLocales,
  localeConfig,
  registerCatalog,
  registeredLocales,
  resetCatalogs,
  resetLocaleConfig,
  resolveLocale,
} from '../../i18n/src/context';
import {
  clearPermissions,
  definePermissions,
  knownPermissions,
} from '../../policy/src/permissions';
import { clearRoles, defineRoles, roleDefinitions } from '../../policy/src/roles';
import { captureProcessRegistries, restoreProcessRegistries } from './registry-snapshot';

/** Every test here mutates process globals; each one hands them back the way it found them. */
const around = (body: () => void): void => {
  const outer = captureProcessRegistries();
  try {
    body();
  } finally {
    restoreProcessRegistries(outer);
  }
};

describe('captureProcessRegistries / restoreProcessRegistries', () => {
  test('a locale set narrowed after the capture is wide again after the restore', () =>
    around(() => {
      resetLocaleConfig();
      const snapshot = captureProcessRegistries();

      // What `defineCatalogs({ default: 'en', locales: { en, fr } })` does at an app's module
      // scope, which is why one test that loads an app decided `<html lang>` for every file
      // after it in the same process.
      configureLocales({ supported: ['en', 'fr'], fallback: 'en' });
      expect(resolveLocale({ header: 'de-DE,de;q=0.9,en;q=0.7' }).locale).toBe('en');

      restoreProcessRegistries(snapshot);

      // The documented behaviour the leak corrupted: `de` is registered, so `de-DE` is `de`.
      expect(resolveLocale({ header: 'de-DE,de;q=0.9,en;q=0.7' })).toEqual({
        locale: 'de',
        direction: 'ltr',
        source: 'header',
      });
    }));

  test('permissions a later file cleared are declared again after the restore', () =>
    around(() => {
      // Stands in for `@ultimat3/admin`'s barrel, which declares `admin:*` at module scope — the
      // registration a `clearPermissions()` in another file destroys for the whole process.
      definePermissions(['admin:read', 'admin:write']);
      const snapshot = captureProcessRegistries();

      clearPermissions();
      expect(knownPermissions()).toEqual([]);

      restoreProcessRegistries(snapshot);

      expect(knownPermissions()).toEqual(expect.arrayContaining(['admin:read', 'admin:write']));
    }));

  test('permissions declared after the capture are gone after the restore', () =>
    around(() => {
      clearPermissions();
      const snapshot = captureProcessRegistries();

      definePermissions(['post:read']);
      expect(knownPermissions()).toEqual(['post:read']);

      restoreProcessRegistries(snapshot);

      expect(knownPermissions()).toEqual([]);
    }));

  test('the role map and its declaration sites both come back', () =>
    around(() => {
      defineRoles({ editor: { grants: ['post:publish'] } });
      const snapshot = captureProcessRegistries();

      clearRoles();
      expect(roleDefinitions()).toEqual({});

      restoreProcessRegistries(snapshot);

      expect(roleDefinitions()['editor']).toEqual({ grants: ['post:publish'] });
    }));

  test('a catalog registered after the capture is gone, and one captured is back', () =>
    around(() => {
      resetCatalogs();
      registerCatalog('en', flattenCatalog({ nav: { home: 'Home' } }));
      const snapshot = captureProcessRegistries();

      resetCatalogs();
      registerCatalog('fr', flattenCatalog({ nav: { home: 'Accueil' } }));

      restoreProcessRegistries(snapshot);

      expect(registeredLocales()).toEqual(['en']);
      expect(catalogFor('en')['nav.home']).toBe('Home');
    }));

  test('a snapshot survives later writes — nothing captured is held by reference', () =>
    around(() => {
      resetLocaleConfig();
      clearPermissions();
      clearRoles();
      const snapshot = captureProcessRegistries();

      // Each of these replaces the module-level value rather than mutating it, so the capture
      // must still describe the process as it was. A capture that aliased the live object would
      // restore whatever the last writer left.
      configureLocales({ supported: ['en'] });
      definePermissions(['post:read']);
      defineRoles({ editor: { grants: ['post:publish'] } });

      expect(snapshot.locales.supported.length).toBeGreaterThan(1);
      expect(snapshot.permissions).toEqual([]);
      expect(snapshot.roles).toEqual({});
    }));

  test('restoring is idempotent — the same snapshot applied twice is one state', () =>
    around(() => {
      resetLocaleConfig();
      clearPermissions();
      definePermissions(['post:read']);
      const snapshot = captureProcessRegistries();

      definePermissions(['org:admin']);
      restoreProcessRegistries(snapshot);
      restoreProcessRegistries(snapshot);

      expect(knownPermissions()).toEqual(['post:read']);
      expect(localeConfig().supported).toEqual(snapshot.locales.supported);
    }));
});
