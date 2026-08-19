// Single responsibility: the English source strings for the keys this package's templates
// emit. Templates carry keys only; the words live here (and in an app's own catalogs, which
// are registered after this one and therefore win). Translating a framework mail means
// shipping `mail.*` in an app catalog — never editing a template.

import {
  type Catalog,
  DEFAULT_LOCALE,
  type Locale,
  loadCatalog,
  type NestedCatalog,
  registerCatalog,
} from '@ultimat3/i18n';

export const MAIL_CATALOG_SOURCE: NestedCatalog = {
  mail: {
    footer: {
      legal: 'You received this message because of activity on your account.',
      help: 'Questions? Reply to this email and a human will answer.',
      unsubscribe: 'Unsubscribe',
    },
    welcome: {
      subject: 'Welcome to {appName}',
      preheader: 'Your {appName} account is ready.',
      heading: 'Welcome, {name}',
      body: 'Your {appName} account is ready. Pick up where you left off any time.',
      cta: 'Open {appName}',
    },
    'verify-email': {
      subject: 'Verify your email address',
      preheader: 'One click and this address is confirmed.',
      heading: 'Verify your email, {name}',
      body: 'Confirm this address so we can secure your account and reach you when it matters.',
      cta: 'Verify email address',
      expiry_one: 'This link expires in {count} minute.',
      expiry_other: 'This link expires in {count} minutes.',
      ignore: 'If you did not create this account, ignore this message.',
    },
    'reset-password': {
      subject: 'Reset your password',
      preheader: 'A link to choose a new password.',
      heading: 'Reset your password, {name}',
      body: 'Choose a new password. Existing sessions stay signed in until you sign them out.',
      cta: 'Choose a new password',
      expiry_one: 'This link expires in {count} minute.',
      expiry_other: 'This link expires in {count} minutes.',
      ignore: 'If you did not ask for this, no action is needed — your password is unchanged.',
    },
    invite: {
      subject: '{inviterName} invited you to {orgName}',
      preheader: 'Your invitation to {orgName}.',
      heading: 'Join {orgName}',
      body: '{inviterName} invited you to collaborate in {orgName}.',
      cta: 'Accept invitation',
      expiry_one: 'This invitation expires in {count} hour.',
      expiry_other: 'This invitation expires in {count} hours.',
    },
    'mfa-enrolled': {
      subject: 'Two-factor authentication is on',
      preheader: 'A new second factor now protects your account.',
      heading: 'Two-factor is on, {name}',
      body: 'Every sign-in now needs a second factor as well as your password.',
      'method-label': 'Method',
      'method-totp': 'Authenticator app',
      'method-webauthn': 'Passkey or security key',
      'method-sms': 'Text message',
      'at-label': 'Enabled',
      help: 'If this was not you, remove the factor and change your password immediately.',
    },
    'security-alert': {
      subject: 'Security alert on your account',
      preheader: 'Confirm recent activity on your account.',
      heading: 'Security alert, {name}',
      alert: 'We noticed activity on your account that we want you to confirm.',
      'event-label': 'Event',
      'ip-label': 'IP address',
      'at-label': 'When',
      help: 'If this was not you, change your password and sign out every other session.',
    },
  },
};

export const MAIL_CATALOG: Catalog = loadCatalog(MAIL_CATALOG_SOURCE);

/** The one locale these strings are written in. */
export const MAIL_CATALOG_LOCALE: Locale = DEFAULT_LOCALE;

/**
 * Register the mail templates' own strings under the ONE locale they are written in.
 *
 * **No locale parameter, and that is the fix**: this catalog is English, so `registerMailCatalog('es')`
 * seated English subjects and headings under `es` where `isMiss` then read FALSE — a fallback locale
 * chain wearing registration as a disguise, the same defect `registerFrameworkCatalog` carried until
 * it lost its own parameter. A locale argument is now a compile error rather than a silent one.
 *
 * **Call it once, at boot.** This is NOT idempotent, and the comment here claimed it was:
 * `registerCatalog` merges the existing entry first and its argument second, so a second call after
 * an app has overridden `mail.*` keys puts the English strings back on top of exactly the keys that
 * app cared enough to translate. Guarding on "has this locale a catalog" — the shape
 * `registerFrameworkCatalog` uses — cannot work here, because the framework catalog has already
 * claimed this locale by the time mail registers; a guard by CONTENT needs an i18n primitive that
 * does not exist, and remembering the call in a module flag goes stale the moment
 * `resetCatalogs()` runs (`packages/testing/src/registry-snapshot.ts`), which would silently stop
 * registering altogether. Stating the limit beats inventing a guard that fails quietly.
 */
export function registerMailCatalog(): void {
  registerCatalog(MAIL_CATALOG_LOCALE, MAIL_CATALOG);
}
