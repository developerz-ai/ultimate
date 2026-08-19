import { beforeEach, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { resetJobDriver } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { blocks } from './blocks';
import { registerMailCatalog } from './catalog';
import {
  createMemoryDriver,
  type MemoryMailDriver,
  resetMailDriver,
  setMailDriver,
} from './driver';
import { defineMail, type SendOptions, send, sendById } from './mail';

registerMailCatalog();
registerCatalog(
  'en',
  loadCatalog({
    test: {
      basic: {
        subject: 'Hi {name}',
        heading: 'Hello {name}',
        body: 'Your invite is waiting.',
      },
    },
  }),
);

const basicInput = t.object({ name: t.string });

const basicMail = defineMail<{ name: string }>({
  id: 'test-basic',
  subject: 'test.basic.subject',
  input: basicInput,
  template: ({ data }) => [
    blocks.heading('test.basic.heading', { name: data.name }),
    blocks.paragraph('test.basic.body'),
  ],
});

let memory: MemoryMailDriver;

beforeEach(() => {
  resetMailDriver();
  memory = createMemoryDriver();
  setMailDriver(memory);
  // `send` enqueues whenever a job driver is ambient, and the driver is process-global. These
  // tests assert on the inline path, so they state that precondition instead of inheriting
  // whichever driver an earlier file in this bun process happened to leave behind.
  resetJobDriver();
});

function codeOf(value: unknown): string {
  return isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

test('send without a locale throws X_MAIL_LOCALE_MISSING', async () => {
  // A JS caller or generated code — TypeScript would reject this at the call site.
  const options = { to: 'ada@example.test' } as unknown as SendOptions;
  expect(codeOf(await caught(send(basicMail, { name: 'Ada' }, options)))).toBe(
    'X_MAIL_LOCALE_MISSING',
  );
});

test('send with an empty locale throws X_MAIL_LOCALE_MISSING', async () => {
  const options = { to: 'ada@example.test', locale: '  ' } as unknown as SendOptions;
  expect(codeOf(await caught(send(basicMail, { name: 'Ada' }, options)))).toBe(
    'X_MAIL_LOCALE_MISSING',
  );
});

test('a valid locale renders both parts and reaches the memory driver', async () => {
  const result = await send(basicMail, { name: 'Ada' }, { to: 'ada@example.test', locale: 'en' });

  expect(result.driver).toBe('memory');
  expect(result.queued).toBe(false);
  expect(memory.sent).toHaveLength(1);

  const entry = memory.lastTo('ada@example.test');
  expect(entry?.message.subject).toBe('Hi Ada');
  expect(entry?.message.html).toContain('Hello Ada');
  expect(entry?.message.text).toContain('Hello Ada');
  expect(entry?.message.text).toContain('Your invite is waiting.');
  expect(entry?.message.locale).toBe('en');
});

test('an unknown mail id is X_MAIL_TEMPLATE_UNKNOWN', async () => {
  const sent = sendById('no-such-mail', { name: 'Ada' }, { to: 'a@example.test', locale: 'en' });
  expect(codeOf(await caught(sent))).toBe('X_MAIL_TEMPLATE_UNKNOWN');
});

test('a duplicate mail id is rejected at definition time', () => {
  const again = (): unknown =>
    defineMail<{ name: string }>({
      id: 'test-basic',
      subject: 'test.basic.subject',
      input: basicInput,
      template: () => [blocks.paragraph('test.basic.body')],
    });

  let thrown: unknown;
  try {
    again();
  } catch (error) {
    thrown = error;
  }
  expect(codeOf(thrown)).toBe('X_MAIL_DUPLICATE');
});

test('sending with no driver configured is X_MAIL_DRIVER_UNAVAILABLE', async () => {
  resetMailDriver();
  const sent = send(basicMail, { name: 'Ada' }, { to: 'ada@example.test', locale: 'en' });
  expect(codeOf(await caught(sent))).toBe('X_MAIL_DRIVER_UNAVAILABLE');
});

test('cc and bcc are accepted and the unsubscribe url reaches both parts', async () => {
  await send(
    basicMail,
    { name: 'Ada' },
    {
      to: ['ada@example.test'],
      cc: ['grace@example.test'],
      bcc: ['ops@example.test'],
      locale: 'en',
      unsubscribeUrl: 'https://example.test/unsubscribe?token=abc',
    },
  );

  const entry = memory.sent[0];
  expect(entry?.result.accepted).toEqual([
    'ada@example.test',
    'grace@example.test',
    'ops@example.test',
  ]);
  expect(entry?.message.html).toContain('https://example.test/unsubscribe?token=abc');
  expect(entry?.message.text).toContain('https://example.test/unsubscribe?token=abc');
});
