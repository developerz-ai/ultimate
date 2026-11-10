// Single responsibility: the English source strings for the keys this package's layout emits —
// the footer every mail carries. An app's own mails carry their keys in the app's catalogs, which
// are registered after this one and therefore win; translating the footer means shipping
// `mail.footer.*` in an app catalog.

import { DEFAULT_LOCALE } from '@ultimat3/core';
import { type Catalog, loadCatalog, type NestedCatalog, registerBaseCatalog } from '@ultimat3/i18n';

export const MAIL_CATALOG_SOURCE: NestedCatalog = {
  mail: {
    footer: {
      legal: 'You received this message because of activity on your account.',
      help: 'Questions? Reply to this email and a human will answer.',
      unsubscribe: 'Unsubscribe',
    },
  },
};

export const MAIL_CATALOG: Catalog = loadCatalog(MAIL_CATALOG_SOURCE);

// At module scope, and that is the whole point: importing `@ultimat3/mail` is what installs these
// strings, so no app and no boot can forget them. `registerMailCatalog()` was the alternative and
// it had **zero** production callers — only this package's own tests — so every `mail.*` string in
// every running Ultimate app rendered as a loud miss, which is issue #249 one package over.
//
// Under an app's catalog, never over it: `registerBaseCatalog` merges the base FIRST and whatever
// `registerCatalog` seated second, so an app that translated `mail.footer.unsubscribe` keeps it
// through every later install. That is the "guard by CONTENT" this file said needed an i18n
// primitive that did not exist — it exists now, and it is idempotent by construction rather than
// by a module flag `resetCatalogs()` would go stale against.
//
// Under the ONE locale these strings are written in. Seating English under `es` made `isMiss` read
// FALSE for a subject nobody had translated — a fallback locale chain wearing registration as a
// disguise. A non-`en` app translates the `mail.*` keys it renders into its own catalog.
registerBaseCatalog(DEFAULT_LOCALE, MAIL_CATALOG);
