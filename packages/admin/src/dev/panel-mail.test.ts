// The mail panel: every caught message, and the catalog gap it exists to make visible — a subject
// that exists in one locale and not another. The gap is computed over ALL messages, never over the
// filtered view, or filtering to one locale would report every subject as complete.

import { describe, expect, test } from 'bun:test';
import { staticDevSources } from './data';
import type { MailFact } from './facts';
import { mailPanel } from './panel-mail';

const mail = (over: Partial<MailFact> & Pick<MailFact, 'id' | 'subject' | 'locale'>): MailFact => ({
  to: 'someone@example.test',
  html: '<p>hi</p>',
  text: 'hi',
  sentAt: '2026-08-19T00:00:00.000Z',
  ...over,
});

const MESSAGES: readonly MailFact[] = [
  mail({ id: 'm1', subject: 'Welcome', locale: 'en' }),
  mail({ id: 'm2', subject: 'Welcome', locale: 'es' }),
  mail({ id: 'm3', subject: 'Receipt', locale: 'en' }),
  mail({ id: 'm4', subject: 'Reminder', locale: 'de' }),
  // `Welcome` in all three: the one complete subject, so "reported" below is a distinction and
  // not a description of every row.
  mail({ id: 'm5', subject: 'Welcome', locale: 'de' }),
];

const data = (params = ''): ReturnType<typeof mailPanel.data> =>
  mailPanel.data(
    staticDevSources({ mail: () => Promise.resolve(MESSAGES) }),
    new URLSearchParams(params),
  );

describe('the locale filter', () => {
  test('no ?locale= shows everything', async () => {
    expect((await data()).messages.map((message) => message.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);
  });

  test('?locale= narrows to that locale only', async () => {
    expect((await data('locale=en')).messages.map((message) => message.id)).toEqual(['m1', 'm3']);
  });

  test('a locale nothing was sent in is an empty list and no selection', async () => {
    const panel = await data('locale=fr');
    expect(panel.messages).toEqual([]);
    expect(panel.selected).toBeNull();
  });

  test('the locale list is every locale seen, sorted and de-duplicated', async () => {
    // Computed over ALL messages, not the filtered view: the picker must still offer the locale
    // the reader is about to switch to.
    expect((await data('locale=de')).locales).toEqual(['de', 'en', 'es']);
  });
});

describe('the selected message', () => {
  test('with no ?id= the first message of the filtered view is shown', async () => {
    expect((await data()).selected?.id).toBe('m1');
    expect((await data('locale=es')).selected?.id).toBe('m2');
  });

  test('?id= selects that message', async () => {
    expect((await data('id=m3')).selected?.id).toBe('m3');
  });

  test('an id outside the current filter is not selected — the panel never shows a hidden row', async () => {
    expect((await data('locale=en&id=m4')).selected).toBeNull();
  });

  test('an unknown id is null, not the first message', async () => {
    expect((await data('id=nope')).selected).toBeNull();
  });

  test('nothing caught at all selects nothing rather than throwing on an empty list', async () => {
    const panel = await mailPanel.data(staticDevSources(), new URLSearchParams());
    expect(panel.selected).toBeNull();
    expect(panel.locales).toEqual([]);
    expect(panel.missingLocales).toEqual([]);
  });
});

describe('the catalog gap', () => {
  test('a subject missing in a locale is reported, and a complete one is not', async () => {
    const panel = await data();
    expect(panel.missingLocales).toEqual([
      { subject: 'Receipt', missing: ['de', 'es'] },
      { subject: 'Reminder', missing: ['en', 'es'] },
    ]);
    // `Welcome` exists in all three locales, so it is absent from the gap list entirely — the
    // yardstick is every locale seen ANYWHERE, not every locale this subject happens to have.
    expect(panel.missingLocales.map((entry) => entry.subject)).not.toContain('Welcome');
  });

  test('the gap is computed over every message, not over the filtered view', async () => {
    // Filtered to `en`, `Welcome`'s Spanish copy is off screen — reporting it as missing here
    // would turn the reader's own filter into a translation bug.
    expect((await data('locale=en')).missingLocales).toEqual(
      (await data()).missingLocales as never,
    );
  });
});
