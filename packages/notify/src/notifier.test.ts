// The declaration: what `notifier()` refuses where it is written, and the fact that what it hands
// back is a `job` — not a ninth primitive, and not a wrapper that has to re-implement retry.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PRIMITIVE_FACTORIES } from '@ultimat3/core';
import { DEFAULT_QUEUE, resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { recorder } from './notify-fixture';
import { resetNotifyStores } from './stores';

const input = t.object({ postId: t.uuid });

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

describe('unit · notifier()', () => {
  test('hands back a job handle, so retry, the queue and the manifest row are inherited', () => {
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.liked',
      input,
      tenant: 'none',
      key: (params) => `like:${params.postId}`,
      queue: 'mail',
      deliver: [{ channel: log.one('email') }],
    });

    expect(handle.kind).toBe('job');
    expect(handle.name).toBe('post.liked');
    expect(handle.queue).toBe('mail');
    expect(handle.queue).not.toBe(DEFAULT_QUEUE);
    expect(handle.retry.attempts).toBeGreaterThan(0);
    // The declared `key` IS the queue's idempotency key: one question, one answer.
    expect(handle.idempotencyKeyFor({ params: { postId: 'p1' } })).toBe('like:p1');
    expect(handle.describe().name).toBe('post.liked');
  });

  test('the payload nests params, so an app field called `recipients` cannot collide', () => {
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.liked',
      input,
      tenant: 'none',
      key: (params) => `like:${params.postId}`,
      deliver: [{ channel: log.one('email') }],
    });

    const parsed = handle.parse({
      params: { postId: '00000000-0000-7000-8000-000000000001' },
      recipients: [{ id: 'ana', locale: 'en-GB' }],
    });
    expect(parsed.params.postId).toBe('00000000-0000-7000-8000-000000000001');
    expect(parsed.recipients?.[0]).toEqual({ id: 'ana', locale: 'en-GB' });
  });

  test('the declared tenant reads the PARAMS, never the envelope', () => {
    const log = recorder();
    const handle = notifier<{ postId: string; orgId: string }>({
      name: 'post.liked',
      input: t.object({ postId: t.uuid, orgId: t.uuid }),
      tenant: (params) => params.orgId,
      key: (params) => `like:${params.postId}`,
      deliver: [{ channel: log.one('email') }],
    });

    expect(handle.tenantFor({ params: { postId: 'p1', orgId: 'org-7' } })).toBe('org-7');
  });

  test('a notifier with no channels is refused at declaration', () => {
    expect(() =>
      notifier<TestParams>({
        name: 'post.liked',
        input,
        tenant: 'none',
        key: (params) => `like:${params.postId}`,
        deliver: [],
      }),
    ).toThrow(/no channels/);
  });

  test('two deliveries sharing a channel name are refused, because the ledger keys on it', () => {
    const log = recorder();
    expect(() =>
      notifier<TestParams>({
        name: 'post.liked',
        input,
        tenant: 'none',
        key: (params) => `like:${params.postId}`,
        deliver: [{ channel: log.one('email') }, { channel: log.one('email'), wait: '1h' }],
      }),
    ).toThrow(/twice/);
  });

  test('it is a FACTORY over a primitive, and PRIMITIVE_FACTORIES says so', () => {
    // The other half of "never invent a ninth": the row is the executable claim, and
    // scripts/primitive-factories.test.ts fails when the export and the row disagree.
    const row = PRIMITIVE_FACTORIES.find((entry) => entry.factory === 'notifier');
    expect(row).toEqual({ factory: 'notifier', pkg: '@ultimat3/notify', kind: 'job' });
  });
});
