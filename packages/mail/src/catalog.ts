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

/** Called at boot next to `registerFrameworkCatalog()`. Idempotent. */
export function registerMailCatalog(locale: Locale = DEFAULT_LOCALE): void {
  registerCatalog(locale, MAIL_CATALOG);
}
