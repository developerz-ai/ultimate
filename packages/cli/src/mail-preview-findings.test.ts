// A declared preview is a test: rendered in every locale by the `i18n` step, a key one locale
// lacks is a finding, and so is a preview a function hands back that its schema refuses.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { blocks, defineMail, registeredMails, restoreMails, t } from '@ultimat3/mail';
import { mailPreviewFindings } from './mail-preview-findings';

// The findings cover EVERY registered mail, so the premise is an empty registry, stated here and
// handed back after — a `resetMails()` took an earlier file's module-scope mails from every later
// file, and on a shared worker another file's mails were this one's extra findings.
const inherited = registeredMails();
beforeAll(() => {
  restoreMails([]);
});
afterAll(() => {
  restoreMails(inherited);
});

test('every declared preview in every locale: a locale missing a key and a bad preview are red', () => {
  registerCatalog('en', loadCatalog({ mpf: { subject: 'Hi {name}', body: 'Body' } }));
  registerCatalog('es', loadCatalog({ mpf: { subject: 'Hola {name}' } }));
  const input = t.object({ name: t.string.min(1) });
  const template = () => [blocks.paragraph('mpf.body')];
  defineMail({ id: 'mpf.good', subject: 'mpf.subject', input, template, preview: { name: 'Ada' } });
  defineMail({
    id: 'mpf.bad',
    subject: 'mpf.subject',
    input,
    template,
    preview: () => ({ name: '' }),
  });
  defineMail({ id: 'mpf.none', subject: 'mpf.subject', input, template });

  const findings = mailPreviewFindings(['en', 'es']).map((finding) => finding.code);
  expect(findings).toEqual([
    'X_MAIL_PREVIEW_INVALID',
    'X_MAIL_PREVIEW_INVALID',
    'X_MAIL_KEY_MISSING',
  ]);
});
