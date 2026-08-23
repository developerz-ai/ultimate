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
import {
  clearRoles,
  defineRoles,
  roleDeclarationSites,
  roleDefinitions,
} from '../../policy/src/roles';
import { captureProcessRegistries, restoreProcessRegistries } from './registry-snapshot';

/**
 * Every test here mutates process globals; each one hands them back the way it found them.
 *
 * `resetCatalogs()` first, and only here: the restore deliberately KEEPS a key nothing can
 * re-register, so a test that declares `brand.name` would otherwise leave it declared for every
 * test after it in this file. Dropping the app layer before the restore makes each case hermetic
 * without asking the subject to behave differently than it does at a real file boundary.
 */
const around = (body: () => void): void => {
  const outer = captureProcessRegistries();
  try {
    body();
  } finally {
    resetCatalogs();
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
      // The site is THIS file, captured before the clear: it is what makes `X_ROLE_REDEFINED`
      // name the app's own declaration rather than whatever frame restored the map.
      const declaredAt = roleDeclarationSites()['editor'];
      expect(declaredAt).toBeString();
      const snapshot = captureProcessRegistries();

      clearRoles();
      expect(roleDefinitions()).toEqual({});
      expect(roleDeclarationSites()).toEqual({});

      restoreProcessRegistries(snapshot);

      expect(roleDefinitions()['editor']).toEqual({ grants: ['post:publish'] });
      expect(roleDeclarationSites()['editor']).toBe(declaredAt);
    }));

  test('a catalog the file cleared is back, key for key', () =>
    around(() => {
      resetCatalogs();
      registerCatalog('en', flattenCatalog({ nav: { home: 'Home' } }));
      const snapshot = captureProcessRegistries();

      resetCatalogs();
      expect(catalogFor('en')['nav.home']).toBeUndefined();

      restoreProcessRegistries(snapshot);

      expect(catalogFor('en')['nav.home']).toBe('Home');
    }));

  /**
   * #312. `loadApp()` inside a test body dynamically imports the app's i18n package, and
   * `defineCatalogs()` there runs at MODULE scope — once per `bun test` process. So a restore
   * that DROPS those keys is unrepairable going forward: the next file's own `import` is a cache
   * hit that registers nothing, and `t('brand.name')` renders `⟦brand.name⟧` for the rest of the
   * run. Observed before this: `undefined`.
   */
  test('a key first declared after the capture survives — no second evaluation can re-add it', () =>
    around(() => {
      resetCatalogs();
      const snapshot = captureProcessRegistries();

      registerCatalog('en', flattenCatalog({ brand: { name: 'Nimbus' } }));

      restoreProcessRegistries(snapshot);

      expect(catalogFor('en')['brand.name']).toBe('Nimbus');
    }));

  test('a locale first registered after the capture survives with it', () =>
    around(() => {
      resetCatalogs();
      const snapshot = captureProcessRegistries();

      registerCatalog('fr', flattenCatalog({ nav: { home: 'Accueil' } }));

      restoreProcessRegistries(snapshot);

      expect(registeredLocales()).toContain('fr');
      expect(catalogFor('fr')['nav.home']).toBe('Accueil');
    }));

  /**
   * An OVERRIDE registered after the capture survives too, and it has to: an app's
   * `defineCatalogs()` overriding a framework base string is the same one-time module-scope
   * declaration as a new key. `dummy/social-media-clone` overrides `admin.denied.body`, and
   * reverting it rendered `@ultimat3/i18n`'s own `This account is missing {permission}` where the
   * app's copy belongs — with no `⟦…⟧` anywhere to show that anything had been lost.
   */
  test('an override registered after the capture survives — an app outranks the base layer', () =>
    around(() => {
      resetCatalogs();
      registerCatalog('en', flattenCatalog({ nav: { home: 'Home' } }));
      const snapshot = captureProcessRegistries();

      registerCatalog('en', flattenCatalog({ nav: { home: 'Accueil' } }));

      restoreProcessRegistries(snapshot);

      expect(catalogFor('en')['nav.home']).toBe('Accueil');
    }));

  /**
   * The cost of that, named: a file that clobbers an inherited key owns the cleanup, and the
   * cleanup is the same `resetCatalogs()` the restore is built to repair around. This is the
   * documented idiom, asserted — not a hole left to prose.
   */
  test('a file that clears its own layer hands back exactly what it inherited', () =>
    around(() => {
      resetCatalogs();
      registerCatalog('en', flattenCatalog({ nav: { home: 'Home' } }));
      const snapshot = captureProcessRegistries();

      registerCatalog('en', flattenCatalog({ nav: { home: 'CLOBBERED' } }));
      resetCatalogs();

      restoreProcessRegistries(snapshot);

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
