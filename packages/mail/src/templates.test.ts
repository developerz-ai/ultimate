import { expect, test } from 'bun:test';
import { translatorFor } from '@ultimat3/i18n';
import type { MailBlock } from './blocks';
import type { MailDefinition } from './mail';
import { type RenderedMail, renderMail } from './render';
import {
  FRAMEWORK_MAILS,
  inviteMail,
  mfaEnrolledMail,
  resetPasswordMail,
  securityAlertMail,
  verifyEmailMail,
  welcomeMail,
} from './templates';

/** A key, not a sentence: lowercase dotted segments, never a space. */
const KEY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

const OPTIONS = { locale: 'en', tz: 'Europe/Berlin' } as const;

interface Case {
  readonly id: string;
  readonly keys: readonly string[];
  readonly rendered: RenderedMail;
}

function keyOf(block: MailBlock): readonly string[] {
  return block.kind === 'divider' ? [] : [block.key];
}

// `NoInfer` on `data`: `MailDefinition<I>` is invariant in `I`, so inferring from the fixture
// too made a literal union (`method: 'totp'`) widen to `string` and fight the mail's own type.
// The mail declares the payload; the fixture is checked against it.
function makeCase<I>(mail: MailDefinition<I>, data: NoInfer<I>): Case {
  const list = mail.template({
    data,
    t: translatorFor(OPTIONS.locale),
    locale: OPTIONS.locale,
    tz: OPTIONS.tz,
  });
  return {
    id: mail.id,
    keys: [mail.subject, ...list.flatMap(keyOf)],
    rendered: renderMail(mail, data, OPTIONS),
  };
}

const AT = new Date('2026-07-26T09:30:00.000Z');

const CASES: readonly Case[] = [
  makeCase(welcomeMail, { name: 'Ada', appName: 'Acme', url: 'https://acme.test/app' }),
  makeCase(verifyEmailMail, {
    name: 'Ada',
    url: 'https://acme.test/verify?token=abc',
    expiresMinutes: 30,
  }),
  makeCase(resetPasswordMail, {
    name: 'Ada',
    url: 'https://acme.test/reset?token=abc',
    expiresMinutes: 1,
  }),
  makeCase(inviteMail, {
    inviterName: 'Grace',
    orgName: 'Acme',
    url: 'https://acme.test/invite?token=abc',
    expiresHours: 48,
  }),
  makeCase(mfaEnrolledMail, { name: 'Ada', method: 'totp', at: AT }),
  makeCase(securityAlertMail, {
    name: 'Ada',
    event: 'session.new-device',
    ip: '203.0.113.7',
    at: AT,
  }),
];

test('every framework mail is covered by a case', () => {
  expect(CASES.map((entry) => entry.id).sort()).toEqual(
    FRAMEWORK_MAILS.map((mail) => mail.id).sort(),
  );
  expect(FRAMEWORK_MAILS).toHaveLength(6);
});

test('every subject and body string is an i18n key, never English', () => {
  for (const entry of CASES) {
    for (const key of entry.keys) {
      expect(key).toMatch(KEY_RE);
      expect(key.includes(' ')).toBe(false);
      expect(key.startsWith('mail.')).toBe(true);
    }
  }
});

test('the shipped catalog renders every key — no miss markers', () => {
  for (const entry of CASES) {
    expect(entry.rendered.html.includes('⟦')).toBe(false);
    expect(entry.rendered.text.includes('⟦')).toBe(false);
    expect(entry.rendered.subject.includes('⟦')).toBe(false);
    expect(entry.rendered.preheader.includes('⟦')).toBe(false);
    // Rendering actually resolved the key rather than echoing it back.
    expect(entry.rendered.subject).not.toMatch(KEY_RE);
    expect(entry.rendered.text.length).toBeGreaterThan(20);
    // No `{placeholder}` survived: a block whose vars were never wired up leaks one.
    expect(entry.rendered.text).not.toContain('{');
    expect(entry.rendered.subject).not.toContain('{');
    expect(entry.rendered.preheader).not.toContain('{');
  }
});

test('plural expiry keys select the right variant', () => {
  const one = CASES.find((entry) => entry.id === 'reset-password');
  const many = CASES.find((entry) => entry.id === 'verify-email');
  expect(one?.rendered.text).toContain('expires in 1 minute.');
  expect(many?.rendered.text).toContain('expires in 30 minutes.');
});

test('dates are formatted in the requested zone, never the server zone', () => {
  const alert = CASES.find((entry) => entry.id === 'security-alert');
  // 09:30 UTC is 11:30 in Europe/Berlin in July.
  expect(alert?.rendered.text).toContain('11:30');
  expect(alert?.rendered.text).toContain('203.0.113.7');
});
