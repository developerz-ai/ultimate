// A declared preview: refused at definition when its own schema refuses it, rendered per locale
// with no send, and its misses reported rather than thrown.

import { describe, expect, test } from 'bun:test';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { t } from '@ultimat3/schema';
import { blocks } from './blocks';
import { defineMail } from './mail';
import { previewableMailIds, previewMail } from './preview';

registerCatalog('en', loadCatalog({ preview: { subject: 'Hi {name}', body: 'Welcome, {name}.' } }));
registerCatalog('es', loadCatalog({ preview: { subject: 'Hola {name}' } }));

const input = t.object({ name: t.string.min(1) });
const template = ({ data }: { data: { name: string } }) => [
  blocks.paragraph('preview.body', { name: data.name }),
];

defineMail({
  id: 'preview-value',
  subject: 'preview.subject',
  input,
  template,
  preview: { name: 'Ada' },
});
defineMail({
  id: 'preview-by-locale',
  subject: 'preview.subject',
  input,
  template,
  preview: (locale) => ({ name: locale === 'es' ? 'Inés' : 'Ada' }),
});
defineMail({ id: 'preview-none', subject: 'preview.subject', input, template });

describe('previewMail', () => {
  test('renders the declared data in each locale, and reports what a locale lacks', () => {
    const en = previewMail('preview-by-locale', { locale: 'en' });
    expect(en.subject).toBe('Hi Ada');
    expect(en.text).toContain('Welcome, Ada.');
    expect(en.misses).toEqual([]);
    const es = previewMail('preview-by-locale', { locale: 'es' });
    expect(es.subject).toBe('Hola Inés');
    expect(es.misses.map((miss) => miss.key)).toContain('preview.body');
  });

  test('a preview the input schema refuses is refused where it is written', () => {
    expect(() =>
      defineMail({
        id: 'preview-bad',
        subject: 'preview.subject',
        input,
        template,
        preview: { name: '' },
      }),
    ).toThrow('X_MAIL_PREVIEW_INVALID');
    defineMail({
      id: 'preview-bad-later',
      subject: 'preview.subject',
      input,
      template,
      preview: () => ({ name: '' }),
    });
    expect(() => previewMail('preview-bad-later', { locale: 'en' })).toThrow(
      'X_MAIL_PREVIEW_INVALID',
    );
  });

  test('a mail with none is X_MAIL_PREVIEW_MISSING, and is not listed as previewable', () => {
    expect(() => previewMail('preview-none', { locale: 'en' })).toThrow('X_MAIL_PREVIEW_MISSING');
    expect(previewableMailIds()).toContain('preview-value');
    expect(previewableMailIds()).not.toContain('preview-none');
  });
});
