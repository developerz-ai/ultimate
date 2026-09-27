// `setMailTransform` — the outbound hook. Failure first: a throwing or malformed transform fails
// the send with a typed error and nothing is delivered (never sent untracked). Then: it runs once
// per send, after render and before the key, so the queue row and every retry carry its bytes.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import type { JobRunArgs } from '@ultimat3/jobs';
import {
  createMemoryDriver as createMemoryJobDriver,
  resetJobDriver,
  setJobDriver,
} from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { blocks } from './blocks';
import type { MailMessage } from './driver';
import {
  createMemoryDriver,
  type MemoryMailDriver,
  resetMailDriver,
  setMailDriver,
} from './driver';
import { mailIdempotencyKey } from './idempotency';
import { sendMailJob } from './job';
import { defineMail, renderMessage, type SendOptions, send } from './mail';
import type { MailTransformMeta } from './transform';
import { setMailTransform } from './transform';

registerCatalog(
  'en',
  loadCatalog({ test: { tx: { subject: 'Hello {name}', body: 'Open https://app.test/x' } } }),
);

const trackedMail = defineMail<{ name: string }>({
  id: 'test-transform',
  subject: 'test.tx.subject',
  input: t.object({ name: t.string }),
  template: () => [blocks.paragraph('test.tx.body')],
});

const TO: SendOptions = { to: 'ada@example.test', locale: 'en', tz: 'UTC' };

let memory: MemoryMailDriver;
let calls: MailTransformMeta[] = [];

/** Deterministic per untransformed key — the contract `MailTransform` states. */
const pixel = (meta: MailTransformMeta): string =>
  `<img src="https://app.test/m/o/${meta.idempotencyKey.slice(-12)}.gif">`;

beforeEach(() => {
  resetMailDriver();
  memory = createMemoryDriver();
  setMailDriver(memory);
  resetJobDriver();
  calls = [];
});

afterEach(() => {
  setMailTransform(undefined);
  resetJobDriver();
});

const codeOf = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (isUltimateError(error) ? error.code : 'not an UltimateError'),
  );

test('a throwing transform fails the send with X_MAIL_TRANSFORM_FAILED and delivers nothing', async () => {
  setMailTransform(() => {
    throw new TypeError('db down');
  });
  expect(await codeOf(send(trackedMail, { name: 'Ada' }, TO))).toBe('X_MAIL_TRANSFORM_FAILED');
  expect(memory.sent).toHaveLength(0);
});

test('a transform returning no message, or an empty text part, fails the send too', async () => {
  setMailTransform(() => ({ subject: 'x' }) as never);
  expect(await codeOf(send(trackedMail, { name: 'Ada' }, TO))).toBe('X_MAIL_TRANSFORM_FAILED');
  setMailTransform((r) => ({ ...r, text: '  ' }));
  expect(await codeOf(send(trackedMail, { name: 'Ada' }, TO))).toBe('X_MAIL_TRANSFORM_FAILED');
  expect(memory.sent).toHaveLength(0);
});

test('a result whose getter throws is a failed transform, and the throw names no app string', async () => {
  class Leaky extends Error {
    override name = 'ada@example.test';
  }
  setMailTransform(() => {
    throw new Leaky('ada@example.test');
  });
  const leaked = await send(trackedMail, { name: 'Ada' }, TO).catch((error: unknown) => error);
  expect(JSON.stringify({ cause: (leaked as { cause?: string }).cause })).not.toContain('ada@');
  setMailTransform(
    () =>
      ({
        get subject(): string {
          throw new TypeError('getter');
        },
        html: '',
        text: 'x',
      }) as never,
  );
  expect(await codeOf(send(trackedMail, { name: 'Ada' }, TO))).toBe('X_MAIL_TRANSFORM_FAILED');
  expect(memory.sent).toHaveLength(0);
});

test('a transform that breaks the subject header is refused by the header gate', async () => {
  setMailTransform((r) => ({ ...r, subject: 'Hi\r\nBcc: evil@x.test' }));
  expect(await codeOf(send(trackedMail, { name: 'Ada' }, TO))).toBe('X_MAIL_HEADER_INVALID');
  expect(memory.sent).toHaveLength(0);
});

test('with no transform installed the message is byte-identical to before', async () => {
  const result = await send(trackedMail, { name: 'Ada' }, TO);
  const plain = renderMessage(trackedMail, { name: 'Ada' }, TO);
  expect(memory.sent[0]?.message).toEqual(plain);
  expect(result.idempotencyKey).toBe(mailIdempotencyKey(plain));
});

test('the transform runs once per send, after render, and sees the untransformed key', async () => {
  setMailTransform(async (rendered, meta) => {
    calls.push(meta);
    return { ...rendered, html: `${rendered.html}${pixel(meta)}` };
  });
  const result = await send(trackedMail, { name: 'Ada' }, TO);
  expect(calls).toHaveLength(1);
  const plain = renderMessage(trackedMail, { name: 'Ada' }, TO);
  expect(calls[0]).toEqual({
    mailName: 'test-transform',
    to: ['ada@example.test'],
    idempotencyKey: mailIdempotencyKey(plain),
    locale: 'en',
  });
  const delivered = memory.sent[0]?.message;
  expect(delivered?.html).toContain('/m/o/');
  // The key is minted over the TRANSFORMED bytes — what the provider actually receives.
  expect(result.idempotencyKey).toBe(mailIdempotencyKey(delivered as MailMessage));
  expect(result.idempotencyKey).not.toBe(mailIdempotencyKey(plain));
});

test('a queued send stores the transformed bytes, and a job retry reuses them without re-running the hook', async () => {
  const queue = createMemoryJobDriver();
  setJobDriver(queue);
  setMailTransform((rendered, meta) => {
    calls.push(meta);
    return { ...rendered, html: `${rendered.html}${pixel(meta)}` };
  });
  const first = await send(trackedMail, { name: 'Ada' }, TO);
  // A re-called send of the same mail: the hook runs again, deterministically, and dedupes.
  const again = await send(trackedMail, { name: 'Ada' }, TO);
  expect(again.id).toBe(first.id);
  expect(calls).toHaveLength(2);

  const row = await queue.introspect?.job(first.id);
  const queued = row?.input as MailMessage;
  expect(queued.html).toContain(pixel(calls[0] as MailTransformMeta));
  // A different mail is a different key, so a different pixel.
  await send(trackedMail, { name: 'Grace' }, TO);
  expect(pixel(calls[2] as MailTransformMeta)).not.toBe(pixel(calls[0] as MailTransformMeta));
  calls.length = 2;
  // Two attempts of the job — a retry after a timeout — deliver the identical message.
  await sendMailJob.run({ input: queued } as JobRunArgs<MailMessage>);
  await sendMailJob.run({ input: queued } as JobRunArgs<MailMessage>);
  expect(memory.sent).toHaveLength(2);
  expect(memory.sent[0]?.message).toEqual(memory.sent[1]?.message as MailMessage);
  expect(calls).toHaveLength(2);
});
