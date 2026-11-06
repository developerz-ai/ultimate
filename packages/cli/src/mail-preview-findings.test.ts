// A declared preview is a test: rendered in every locale by the `i18n` step, a key one locale
// lacks is a finding, and so is a preview a function hands back that its schema refuses.

import { afterAll, expect, test } from 'bun:test';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { blocks, defineMail, resetMails, t } from '@ultimat3/mail';
import { mailPreviewFindings } from './mail-preview-findings';

afterAll(() => {
  resetMails();
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
