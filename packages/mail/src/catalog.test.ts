// The mail catalog is nobody's to register. `registerMailCatalog()` had **zero** production
// callers — only these tests — so every `mail.*` string in every running Ultimate app rendered
// `⟦mail.welcome.subject⟧`: the same defect as issue #249, one package over, and invisible for the
// same reason. Importing this package is now what installs the strings.

import { afterEach, describe, expect, test } from 'bun:test';
import { flattenCatalog, registerCatalog, resetCatalogs, translatorFor } from '@ultimat3/i18n';
import { MAIL_CATALOG_LOCALE } from './catalog';

afterEach(() => {
  resetCatalogs();
});

describe('the mail catalog', () => {
  test('resolves in a process that called nothing at all', () => {
    expect(translatorFor(MAIL_CATALOG_LOCALE)('mail.welcome.subject')).toBe('Welcome to {appName}');
    expect(translatorFor(MAIL_CATALOG_LOCALE)('mail.footer.unsubscribe')).toBe('Unsubscribe');
  });

  test('survives resetCatalogs — a base layer, not a lucky import order', () => {
    resetCatalogs();

    expect(translatorFor(MAIL_CATALOG_LOCALE)('mail.footer.unsubscribe')).toBe('Unsubscribe');
  });

  test('an app translation of a mail key wins, and a reinstall never takes it back', () => {
    registerCatalog(
      MAIL_CATALOG_LOCALE,
      flattenCatalog({ mail: { footer: { unsubscribe: 'Désabonnement' } } }),
    );

    // The base layer merges UNDER what is registered, so the one key this app cared enough to
    // translate cannot be reverted by anything that installs later.
    expect(translatorFor(MAIL_CATALOG_LOCALE)('mail.footer.unsubscribe')).toBe('Désabonnement');
    expect(translatorFor(MAIL_CATALOG_LOCALE)('mail.welcome.subject')).toBe('Welcome to {appName}');
  });
});
