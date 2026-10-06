/**
 * The audit contract is `@ultimat3/core`'s since `query({ audit: true })` shipped: this package
 * re-exports it unchanged, and an action's record must carry every field core declares — `name`
 * beside the deprecated `action` alias, and `primitive` — exactly as `@ultimat3/query`'s
 * `audit.test.ts` holds a read's record to the same list. The two packages cannot import each
 * other, so `AUDIT_RECORD_FIELDS` is the parity pin both sides assert against.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as core from '@ultimat3/core';
import { AUDIT_RECORD_FIELDS, createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { resetAuditSink, setAuditSink } from './audit';
import { memoryAuditSink } from './audit-memory';
import * as barrel from './index';
import { invoke } from './invoke';
import { mutator } from './mutator';
import { resetRegistry } from './registry';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const editor = createContext({
  actor: { ...userActor({ id: 'u1' }), permissions: ['post:publish'] },
});
const reader = createContext({ actor: userActor({ id: 'u2' }) });

const archivePost = action({
  input: Input,
  output: Output,
  policy: can('post:publish'),
  audit: true,
  handle: ({ input }) => ({ id: input.postId }),
}).named('archivePost');

afterEach(() => {
  resetRegistry();
  resetAuditSink();
});

describe('unit · the audit seam is core’s, re-exported', () => {
  test('setAuditSink / getAuditSink / resetAuditSink are core’s own functions', () => {
    expect(barrel.setAuditSink).toBe(core.setAuditSink);
    expect(barrel.getAuditSink).toBe(core.getAuditSink);
    expect(barrel.resetAuditSink).toBe(core.resetAuditSink);
  });

  test('a sink installed through core is the one an action writes to', async () => {
    const sink = memoryAuditSink();
    core.setAuditSink(sink);

    await invoke(archivePost, { postId: POST_ID }, { ctx: editor });

    expect(sink.records()).toHaveLength(1);
  });
});

describe('unit · an action’s record carries every field core declares', () => {
  test('allowed: name and its deprecated alias agree, primitive is action', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);

    await invoke(archivePost, { postId: POST_ID }, { ctx: editor });

    const record = sink.records()[0];
    if (record === undefined) return expect.unreachable();
    expect(Object.keys(record).sort()).toEqual([...AUDIT_RECORD_FIELDS].sort());
    expect(record).toMatchObject({
      name: 'archivePost',
      action: 'archivePost',
      primitive: 'action',
      mutator: false,
    });
  });

  test('denied: the same shape, the same alias', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);

    await invoke(archivePost, { postId: POST_ID }, { ctx: reader }).catch(() => undefined);

    const record = sink.records()[0];
    if (record === undefined) return expect.unreachable();
    expect(Object.keys(record).sort()).toEqual([...AUDIT_RECORD_FIELDS].sort());
    expect(record).toMatchObject({ outcome: 'denied', name: 'archivePost', action: 'archivePost' });
  });

  test('a mutator is primitive action, mutator true — the refinement, not a second primitive', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);
    const publishPost = mutator({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      idempotent: true,
      audit: true,
      local: () => undefined,
      server: (_ctx, input) => ({ id: input.postId }),
      conflict: 'server-wins',
    }).named('publishPost');

    await publishPost.server(editor, { postId: POST_ID });

    expect(sink.records()[0]).toMatchObject({
      name: 'publishPost',
      action: 'publishPost',
      primitive: 'action',
      mutator: true,
    });
  });
});
