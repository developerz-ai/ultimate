/**
 * The audit contract is `@ultimat3/core`'s since `query({ audit: true })` shipped: this package
 * re-exports its two types and none of its values, and an action's record must carry every field core declares — `name`
 * and `primitive`, both required since 25.0.0 — exactly as `@ultimat3/query`'s
 * `audit.test.ts` holds a read's record to the same list. The two packages cannot import each
 * other, so `AUDIT_RECORD_FIELDS` is the parity pin both sides assert against.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as core from '@ultimat3/core';
import {
  AUDIT_RECORD_FIELDS,
  ctxOf,
  resetAuditSink,
  setAuditSink,
  userActor,
} from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { memoryAuditSink } from './audit-memory';
import * as barrel from './index';
import { invoke } from './invoke';
import { mutator } from './mutator';
import { resetActions } from './registry';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const editor = ctxOf({
  actor: { ...userActor({ id: 'u1' }), permissions: ['post:publish'] },
});
const reader = ctxOf({ actor: userActor({ id: 'u2' }) });

const archivePost = action({
  input: Input,
  output: Output,
  policy: can('post:publish'),
  audit: true,
  handle: ({ input }) => ({ id: input.postId }),
}).named('archivePost');

afterEach(() => {
  resetActions();
  resetAuditSink();
});

describe('unit · the audit seam is core’s, and only core exports its slot', () => {
  // 25.0.0: one value, one import path. The barrel re-exported core's three slot functions "so no
  // import moves", which made `@ultimat3/action` a second answer to where the sink is installed.
  test('setAuditSink / getAuditSink / resetAuditSink are not re-exported by this package', () => {
    const exported: Record<string, unknown> = barrel;
    for (const name of ['setAuditSink', 'getAuditSink', 'resetAuditSink']) {
      expect(exported[name]).toBeUndefined();
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('a sink installed through core is the one an action writes to', async () => {
    const sink = memoryAuditSink();
    core.setAuditSink(sink);

    await invoke(archivePost, { postId: POST_ID }, { ctx: editor });

    expect(sink.records()).toHaveLength(1);
  });
});

describe('unit · an action’s record carries every field core declares', () => {
  test('the field list has no `action` alias — 25.0.0 dropped it, `name` is the one spelling', () => {
    expect(AUDIT_RECORD_FIELDS).not.toContain('action');
    expect(AUDIT_RECORD_FIELDS).toContain('name');
    expect(AUDIT_RECORD_FIELDS).toContain('primitive');
  });

  test('allowed: the record names the action once, and primitive is action', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);

    await invoke(archivePost, { postId: POST_ID }, { ctx: editor });

    const record = sink.records()[0];
    if (record === undefined) return expect.unreachable();
    expect(Object.keys(record).sort()).toEqual([...AUDIT_RECORD_FIELDS].sort());
    expect(record).toMatchObject({ name: 'archivePost', primitive: 'action', mutator: false });
    expect(record).not.toHaveProperty('action');
  });

  test('denied: the same shape, no alias', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);

    await invoke(archivePost, { postId: POST_ID }, { ctx: reader }).catch(() => undefined);

    const record = sink.records()[0];
    if (record === undefined) return expect.unreachable();
    expect(Object.keys(record).sort()).toEqual([...AUDIT_RECORD_FIELDS].sort());
    expect(record).toMatchObject({ outcome: 'denied', name: 'archivePost' });
    expect(record).not.toHaveProperty('action');
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
      primitive: 'action',
      mutator: true,
    });
  });
});
