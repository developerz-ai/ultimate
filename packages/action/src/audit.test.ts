import { afterEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { AuditRecord, AuditSink } from './audit';
import { memoryAuditSink, resetAuditSink, setAuditSink } from './audit';
import { MemoryIdempotencyStore } from './idempotency';
import * as surface from './index';
import { invoke } from './invoke';
import { mutator } from './mutator';
import { resetRegistry } from './registry';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const readerActor = userActor({ id: 'u2' });
const editor = createContext({ actor: editorActor });
const reader = createContext({ actor: readerActor });

const publishPost = (audit = true) =>
  mutator({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    ...(audit ? { audit: true } : {}),
    local: () => undefined,
    server: (_ctx, input) => ({ id: input.postId, published: true }),
    conflict: 'server-wins',
  }).named('publishPost');

/** A sink that refuses everything — the failure mode "reported, not silently swallowed" is about. */
const refusingSink = (): AuditSink => ({
  write: (): never => {
    throw new TypeError('audit table is gone');
  },
});

afterEach(() => {
  resetRegistry();
  resetAuditSink();
});

describe('the audit seam', () => {
  test('a mutator running outside /admin is recorded', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);

    await publishPost().server(editor, { postId: POST_ID });

    expect(sink.records()).toHaveLength(1);
    expect(sink.records()[0]?.action).toBe('publishPost');
    expect(sink.records()[0]?.outcome).toBe('allowed');
    expect(sink.records()[0]?.mutator).toBe(true);
  });

  test('a declaration without `audit` records nothing — opt-in, never a global switch', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);

    await publishPost(false).server(editor, { postId: POST_ID });

    expect(sink.records()).toEqual([]);
  });

  test('a denied attempt is recorded, and the denial still reaches the caller', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);
    const target = publishPost();

    const failure = await target.server(reader, { postId: POST_ID }).catch((e: unknown) => e);

    expect((failure as { code?: string }).code).toBe('X_FORBIDDEN');
    const record = sink.records()[0];
    expect(record?.outcome).toBe('denied');
    expect(record?.failure?.code).toBe('X_FORBIDDEN');
    // The input is what makes a denial readable: the handler never ran, so nothing in app code
    // could have captured what was attempted.
    expect(record?.input).toEqual({ postId: POST_ID });
  });

  test('a handler that throws is recorded as `failed`, carrying its own code', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);
    const drifted = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      audit: true,
      handle: ({ input }) => ({ id: input.postId, published: 'yes' }),
    }).named('publishPost');

    const failure = await invoke(drifted, { postId: POST_ID }, { ctx: editor }).catch(
      (e: unknown) => e,
    );

    expect((failure as { code?: string }).code).toBe('X_OUTPUT_INVALID');
    expect(sink.records()[0]?.outcome).toBe('failed');
    expect(sink.records()[0]?.failure?.code).toBe('X_OUTPUT_INVALID');
    expect(sink.records()[0]?.failure?.error).toBe(failure);
  });

  test('an input that never parsed is recorded WITHOUT the raw payload', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);
    const target = publishPost();

    await target.server(editor, { postId: "'; drop table posts --" }).catch(() => undefined);

    const record = sink.records()[0];
    expect(record?.outcome).toBe('failed');
    expect(record?.failure?.code).toBe('X_INPUT_INVALID');
    // An unvalidated body is attacker-shaped. Handing one to a sink that writes it to a table is
    // how an audit trail becomes an injection surface, so the record says nothing rather than
    // something unchecked.
    expect(record?.input).toBeUndefined();
  });

  test('the record carries the context, not a guess at which of its facts matter', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);
    const target = publishPost();

    await invoke(target, { postId: POST_ID }, { ctx: editor, surface: 'mcp' });

    const record = sink.records()[0] as AuditRecord;
    expect(record.ctx.actor.id).toBe('u1');
    expect(record.ctx.requestId).toBe(editor.requestId);
    expect(record.ctx.traceId).toBe(editor.traceId);
    expect(record.surface).toBe('mcp');
    expect(record.at).toBeInstanceOf(Date);
  });

  test('an impersonated call records the actor it ran AS, not the ambient one', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);
    const target = publishPost();

    await target.as(editorActor, { postId: POST_ID }, { ctx: reader });

    expect(sink.records()[0]?.ctx.actor.id).toBe('u1');
  });

  test('a replayed idempotent call is recorded as a call, not a second write', async () => {
    const sink = memoryAuditSink();
    setAuditSink(sink);
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      audit: true,
      idempotent: true,
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishPost');
    const store = new MemoryIdempotencyStore();
    const options = { ctx: editor, idempotencyKey: 'k1', store };

    await invoke(target, { postId: POST_ID }, options);
    await invoke(target, { postId: POST_ID }, options);

    expect(sink.records().map((record) => record.replayed)).toEqual([false, true]);
    // The NAMESPACED key: the same header under two actions is two keys, so a row keyed on the
    // caller's string alone would collide across them.
    expect(sink.records()[0]?.idempotencyKey).toBe('publishPost:k1');
  });

  test('`audit: true` with no sink installed refuses before the handler runs', async () => {
    let runs = 0;
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      audit: true,
      handle: ({ input }) => {
        runs += 1;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    const failure = await invoke(target, { postId: POST_ID }, { ctx: editor }).catch(
      (e: unknown) => e,
    );

    expect((failure as { code?: string }).code).toBe('X_AUDIT_SINK_MISSING');
    // The one audit failure with no committed write behind it, which is why it is checked first.
    expect(runs).toBe(0);
  });

  test('a sink that refuses a SUCCESSFUL record fails the invocation', async () => {
    setAuditSink(refusingSink());
    const target = publishPost();

    const failure = await target.server(editor, { postId: POST_ID }).catch((e: unknown) => e);

    // The opposite of `bustAfterCommit`: a dropped cache entry expires by TTL and the stack
    // heals itself, while nothing ever re-derives an audit row that was never written.
    expect((failure as { code?: string }).code).toBe('X_AUDIT_SINK_FAILED');
    expect((failure as { cause?: string }).cause).toContain('already committed');
    expect((failure as { sourceError?: unknown }).sourceError).toBeInstanceOf(TypeError);
  });

  test('a refused `allowed` record is not re-recorded as the action having failed', async () => {
    const written: AuditRecord[] = [];
    setAuditSink({
      write: (record: AuditRecord): void => {
        written.push(record);
        throw new TypeError('audit table is gone');
      },
    });

    await publishPost()
      .server(editor, { postId: POST_ID })
      .catch(() => undefined);

    // One attempt, one attempted record. `X_AUDIT_SINK_FAILED` describes the ROW, not the
    // handler — a second row calling this `failed` would be the audit trail lying about a
    // write that committed.
    expect(written.map((record) => record.outcome)).toEqual(['allowed']);
  });

  test('a sink that refuses a DENIED record never replaces the denial', async () => {
    setAuditSink(refusingSink());
    const target = publishPost();

    const failure = await target.server(reader, { postId: POST_ID }).catch((e: unknown) => e);

    // Answering `X_AUDIT_SINK_FAILED` here would hide the refusal from whoever has to act on it,
    // and would answer a probing client differently depending on whether the audit backend was
    // up — an oracle. The sink failure is logged instead.
    expect((failure as { code?: string }).code).toBe('X_FORBIDDEN');
  });

  test('the sink has one caller: nothing that writes to it is exported', () => {
    const exported = Object.keys(surface);

    for (const name of ['auditSettled', 'auditThrew', 'auditSinkFor']) {
      expect(exported).not.toContain(name);
    }
    expect(exported).toContain('setAuditSink');
  });

  test('`audited` is published on the descriptor, so the fact is checkable', () => {
    expect(publishPost().describe().audited).toBe(true);
    expect(publishPost(false).describe().audited).toBe(false);
  });
});
