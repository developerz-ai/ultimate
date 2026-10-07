// The mail catalog is nobody's to register. `registerMailCatalog()` had **zero** production
// callers — only these tests — so every `mail.*` string in every running Ultimate app rendered
// `⟦mail.welcome.subject⟧`: the same defect as issue #249, one package over, and invisible for the
// same reason. Importing this package is now what installs the strings.

import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_LOCALE } from '@ultimat3/core';
// Loaded for its side effect alone: the catalog registers itself on import, as in a real process.
import './catalog';
import { flattenCatalog, registerCatalog, resetCatalogs, translatorFor } from '@ultimat3/i18n';

afterEach(() => {
  resetCatalogs();
});

describe('the mail catalog', () => {
  test('resolves in a process that called nothing at all', () => {
    expect(translatorFor(DEFAULT_LOCALE)('mail.welcome.subject', { appName: 'Acme' })).toBe(
      'Welcome to Acme',
    );
    expect(translatorFor(DEFAULT_LOCALE)('mail.footer.unsubscribe')).toBe('Unsubscribe');
  });

  test('survives resetCatalogs — a base layer, not a lucky import order', () => {
    resetCatalogs();

    expect(translatorFor(DEFAULT_LOCALE)('mail.footer.unsubscribe')).toBe('Unsubscribe');
  });

  test('an app translation of a mail key wins, and a reinstall never takes it back', () => {
    registerCatalog(
      DEFAULT_LOCALE,
      flattenCatalog({ mail: { footer: { unsubscribe: 'Désabonnement' } } }),
    );

    // The base layer merges UNDER what is registered, so the one key this app cared enough to
    // translate cannot be reverted by anything that installs later.
    expect(translatorFor(DEFAULT_LOCALE)('mail.footer.unsubscribe')).toBe('Désabonnement');
    expect(translatorFor(DEFAULT_LOCALE)('mail.welcome.subject', { appName: 'Acme' })).toBe(
      'Welcome to Acme',
    );
  });
});
