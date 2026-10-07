import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import {
  createJobsFacade,
  memoryJobDriver,
  memoryOutboxStore,
  resetJobDriver,
  resetJobsFacade,
  setJobDriver,
  setJobsFacade,
} from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { blocks } from './blocks';
import {
  type MemoryMailDriver,
  memoryMailDriver,
  messageHeaders,
  resetMailDriver,
  setMailDriver,
} from './driver';
import { mailMessageSchema } from './job';
import {
  defineMail,
  mailFor,
  registeredMailIds,
  registeredMails,
  type SendOptions,
  send,
  sendById,
} from './mail';

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

// A SECOND registration, with an id that sorts before the first: the registry's ordering is
// unobservable with one entry, and "sorted by id" is what the `/_x` panel and `x mail list`
// present. Defined after `basicMail` so insertion order and sorted order disagree.
const alphaMail = defineMail<{ name: string }>({
  id: 'test-alpha',
  subject: 'test.basic.subject',
  input: basicInput,
  template: () => [blocks.paragraph('test.basic.body')],
});

// A THIRD, whose id differs from the others in CASE: `localeCompare` puts `test-Zeta` after
// `test-basic`, a code-unit sort puts it first — the one input on which the two orders disagree.
defineMail<{ name: string }>({
  id: 'test-Zeta',
  subject: 'test.basic.subject',
  input: basicInput,
  template: () => [blocks.paragraph('test.basic.body')],
});

/** The facade's transaction token, named without importing `@ultimat3/entity` into this package. */
type Tx = NonNullable<ReturnType<Parameters<typeof createJobsFacade>[1]>>;

let memory: MemoryMailDriver;

beforeEach(() => {
  resetMailDriver();
  memory = memoryMailDriver();
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

test('unsubscribeOneClick: false reaches the envelope and survives the queue schema', async () => {
  await send(
    basicMail,
    { name: 'Ada' },
    {
      to: 'ada@example.test',
      locale: 'en',
      unsubscribeUrl: 'https://example.test/unsubscribe/confirm?token=abc',
      unsubscribeOneClick: false,
    },
  );
  const sent = memory.sent[0]?.message;
  expect(sent?.unsubscribeOneClick).toBe(false);
  if (sent === undefined) expect.unreachable('expected one sent message');
  const parsed = await mailMessageSchema['~standard'].validate(sent);
  expect('issues' in parsed && parsed.issues !== undefined).toBe(false);
  expect(messageHeaders(sent)['List-Unsubscribe-Post']).toBeUndefined();
  // The footer link is the same GET confirm page.
  expect(sent.html).toContain('https://example.test/unsubscribe/confirm?token=abc');
});

// One recipient rule on both paths: what the queue schema refuses, `send()` refuses at the call
// site, whichever driver is installed — never `queued: true` and then a worker's parse failure.
test('a recipient the envelope gate refuses is refused at send(), on the memory driver too', async () => {
  for (const options of [
    { to: 'josé@exämple.test', locale: 'en' },
    { to: 'ada@example.test', cc: ['a<b@x.test'], locale: 'en' },
    { to: 'ada@example.test', bcc: ['ops@x.test\u0007'], locale: 'en' },
    { to: 'ada@example.test', replyTo: 'Ada <adä@x.test>', locale: 'en' },
  ] satisfies SendOptions[]) {
    expect(codeOf(await caught(send(basicMail, { name: 'Ada' }, options)))).toBe(
      'X_MAIL_ADDRESS_INVALID',
    );
  }
  expect(memory.sent).toHaveLength(0);
});

// The queue schema types `unsubscribeUrl` as `t.url`; inline, an unparseable one went out as
// `List-Unsubscribe: <not a url>`. Same rule, refused at the call site.
test('an unsubscribeUrl the queue schema refuses is refused at send()', async () => {
  const options: SendOptions = {
    to: 'ada@example.test',
    unsubscribeUrl: 'not a url',
    locale: 'en',
  };
  expect(codeOf(await caught(send(basicMail, { name: 'Ada' }, options)))).toBe(
    'X_VALIDATION_FAILED',
  );
  expect(memory.sent).toHaveLength(0);
});

describe('the registry', () => {
  test('mailFor answers the very definition defineMail returned, and undefined otherwise', () => {
    // Identity: `sendById` looks a mail up here and hands it to `send`, so a lookup that
    // rebuilt the definition would re-parse against a different schema object.
    expect(mailFor('test-basic')).toBe(basicMail);
    expect(mailFor('no-such-mail')).toBeUndefined();
  });

  test('registeredMails is sorted by id and agrees with registeredMailIds', () => {
    const ids = registeredMails().map((definition) => definition.id);
    expect(ids).toContain('test-basic');
    expect(ids).toContain('test-alpha');
    expect(ids).toEqual([...ids].sort());
    // Sorted, NOT insertion order: `test-alpha` was defined second and comes first.
    expect(ids.indexOf('test-alpha')).toBeLessThan(ids.indexOf('test-basic'));
    expect(mailFor('test-alpha')).toBe(alphaMail);
    // Two views of one map — a reader listing mails and a reader listing ids must not disagree.
    expect(ids).toEqual([...registeredMailIds()]);
    // The full definition, not just the id: the `/_x` panel renders the subject key off this.
    expect(registeredMails().find((d) => d.id === 'test-basic')?.subject).toBe(
      'test.basic.subject',
    );
  });
});

describe('the queue path', () => {
  afterEach(() => {
    resetJobDriver();
  });

  test('a configured job driver means the message is enqueued, not delivered', async () => {
    setJobDriver(memoryJobDriver());
    const result = await send(basicMail, { name: 'Ada' }, { to: 'ada@example.test', locale: 'en' });

    expect(result.queued).toBe(true);
    expect(result.driver).toBe('queue');
    // Nothing reached the transport: that is the whole point of enqueuing.
    expect(memory.sent).toHaveLength(0);
    // The id is the QUEUE row's, not a transport's.
    expect(result.id).not.toBe('');
    expect(result.idempotencyKey).toMatch(/^mail:test-basic:[0-9a-f]{32}$/);
  });

  test('the queued result reports every envelope recipient, cc and bcc included', async () => {
    setJobDriver(memoryJobDriver());
    const result = await send(
      basicMail,
      { name: 'Ada' },
      {
        to: 'ada@example.test',
        cc: ['grace@example.test'],
        bcc: ['ops@example.test'],
        locale: 'en',
      },
    );
    expect(result.accepted).toEqual(['ada@example.test', 'grace@example.test', 'ops@example.test']);
    expect(result.queued).toBe(true);
  });

  test('two identical sends dedupe onto one queue row', async () => {
    setJobDriver(memoryJobDriver());
    const options: SendOptions = { to: 'ada@example.test', locale: 'en' };
    const first = await send(basicMail, { name: 'Ada' }, options);
    const second = await send(basicMail, { name: 'Ada' }, options);
    // `onConflict: 'dedupe'` against a content-derived key: a retried request is one email.
    expect(second.id).toBe(first.id);
    // Different content is a different key, so it is a second row.
    const other = await send(basicMail, { name: 'Grace' }, options);
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(other.id).not.toBe(first.id);
  });

  // `s1-con #3`: `send()` called `jobDriver().enqueue` on the pool, autocommitted, so a handler that
  // rolled back after sending still mailed. Through the facade, an ambient transaction STAGES the
  // row — nothing reaches the queue until that transaction commits.
  test('inside a transaction the send is staged on it, not published to the queue', async () => {
    const queue = memoryJobDriver();
    setJobDriver(queue);
    const store = memoryOutboxStore();
    const tx = { id: 'request-tx' } as unknown as Tx;
    setJobsFacade(createJobsFacade({ store, driver: queue }, () => tx));
    try {
      const result = await send(
        basicMail,
        { name: 'Ada' },
        { to: 'ada@example.test', locale: 'en' },
      );
      expect(result.queued).toBe(true);
      expect((await queue.introspect?.list()) ?? []).toEqual([]);
      await store.rollback(tx);
      expect(await store.claim(10)).toEqual([]);
      expect(memory.sent).toHaveLength(0);
    } finally {
      resetJobsFacade();
    }
  });

  test('sync: true delivers inline even with a queue configured', async () => {
    setJobDriver(memoryJobDriver());
    const result = await send(
      basicMail,
      { name: 'Ada' },
      { to: 'ada@example.test', locale: 'en', sync: true },
    );
    expect(result.queued).toBe(false);
    expect(result.driver).toBe('memory');
    expect(memory.sent).toHaveLength(1);
  });
});

test('sendById renders and delivers the mail the id names', async () => {
  const result = await sendById(
    'test-basic',
    { name: 'Ada' },
    { to: 'ada@example.test', locale: 'en' },
  );
  expect(result.driver).toBe('memory');
  expect(memory.lastTo('ada@example.test')?.message.subject).toBe('Hi Ada');
  // `data` is parsed through the mail's own schema, not trusted — the registry erased `I`.
  const bad = sendById('test-basic', { name: 42 }, { to: 'a@b.test', locale: 'en' });
  expect(codeOf(await caught(bad))).toBe('X_VALIDATION_FAILED');
});
