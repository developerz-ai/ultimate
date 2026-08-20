// The span has to cover the whole invocation and say something about it. Before this it wrapped
// `handle` alone and carried no attributes at all, so `def.row()` — the loader a row-level policy
// needs — ran inside no span, and a 2s p99 reported 40ms with a 1.96s gap nothing named.

import { describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import {
  configureTelemetry,
  createContext,
  currentSpan,
  memoryExporter,
  resetTelemetry,
  userActor,
} from '@ultimat3/core';
import type { Actor as PolicyActor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { idempotencyKeyFor } from './idempotency-key';
import { MemoryIdempotencyStore } from './idempotency-memory';
import { invoke } from './invoke';

const Input = t.object({ postId: t.string });
const Output = t.object({ id: t.string });
// `permissions` — direct grants, bypassing roles — is a field of POLICY's actor
// (`CoreActor & PolicyActorFields`), which is what `can()` reads through `actorHas`. Core's
// `Actor` has none and cannot: core is tier 0 and knows nothing about grants.
const editorActor: PolicyActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const editor = createContext({ actor: editorActor });
/** No grant at all — the denial half, and the reason `permissions: []` is written out. */
const strangerActor: PolicyActor = { ...userActor({ id: 'u2' }), permissions: [] };
const stranger = createContext({ actor: strangerActor });

/**
 * Records which span was ACTIVE while `row:` loaded and while the policy decided — the two stages
 * the old span excluded, and where the missing 1.96s of a 2s p99 actually was. Structural rather
 * than timed: "was this work inside the span" is the claim, and the test clock is frozen.
 */
// `| undefined` is the honest type, not a widening: `currentSpan()` answers `undefined` when the
// stage ran OUTSIDE any span, which is the bug this file exists to catch — so the recorder has to
// be able to hold it. `exactOptionalPropertyTypes` refuses to write it into a bare `row?: string`.
function publishPost(inside: { row?: string | undefined; policy?: string | undefined } = {}) {
  return action({
    input: Input,
    output: Output,
    policy: can<{ readonly postId: string }, { readonly authorId: string }>('post:publish', () => {
      inside.policy = currentSpan()?.name;
      return true;
    }),
    idempotent: true,
    row: () => {
      inside.row = currentSpan()?.name;
      return { authorId: 'u1' };
    },
    handle: ({ input }) => ({ id: input.postId }),
  }).named('publishPost');
}

async function traced(run: () => Promise<unknown>): Promise<readonly ReadableSpan[]> {
  const exporter = memoryExporter();
  configureTelemetry({ exporter });
  try {
    await run().catch(() => undefined);
    return exporter.spans;
  } finally {
    resetTelemetry();
  }
}

describe('the action span covers the whole invocation', () => {
  test('the row loader and the guard both run INSIDE the span, not in a gap beside it', async () => {
    const inside: { row?: string; policy?: string } = {};
    const spans = await traced(() =>
      invoke(publishPost(inside), { postId: 'p1' }, { ctx: editor }),
    );
    expect(spans.map((span) => span.name)).toEqual(['action.publishPost']);
    expect(inside.row).toBe('action.publishPost');
    expect(inside.policy).toBe('action.publishPost');
  });

  test('exactly one span per invocation — the handler no longer has its own', async () => {
    const spans = await traced(() => invoke(publishPost(), { postId: 'p1' }, { ctx: editor }));
    expect(spans.filter((span) => span.name === 'action.publishPost')).toHaveLength(1);
  });
});

describe('the span says who, where and how it ended', () => {
  test('an allowed call carries surface, actor kind and outcome', async () => {
    const spans = await traced(() =>
      invoke(publishPost(), { postId: 'p1' }, { ctx: editor, surface: 'mcp' }),
    );
    const attributes = spans[0]?.attributes ?? {};
    expect(attributes['ultimate.primitive']).toBe('action');
    expect(attributes['ultimate.action']).toBe('publishPost');
    expect(attributes['ultimate.surface']).toBe('mcp');
    expect(attributes['ultimate.actor.kind']).toBe('user');
    expect(attributes['ultimate.outcome']).toBe('allowed');
  });

  test('a denial is `denied`, not merely an error — the two are different questions', async () => {
    const spans = await traced(() => invoke(publishPost(), { postId: 'p1' }, { ctx: stranger }));
    expect(spans[0]?.attributes['ultimate.outcome']).toBe('denied');
    expect(spans[0]?.attributes['ultimate.error.code']).toBe('X_FORBIDDEN');
  });

  test('a replay says so, and carries the namespaced key a retry is joined by', async () => {
    const target = publishPost();
    const store = new MemoryIdempotencyStore();
    const options = { ctx: editor, store, idempotencyKey: 'k1' } as const;
    const spans = await traced(async () => {
      await invoke(target, { postId: 'p1' }, options);
      await invoke(target, { postId: 'p1' }, options);
    });
    expect(spans).toHaveLength(2);
    expect(spans[0]?.attributes['ultimate.idempotency.replayed']).toBe(false);
    expect(spans[1]?.attributes['ultimate.idempotency.replayed']).toBe(true);
    expect(spans[1]?.attributes['ultimate.idempotency.key']).toBe(
      idempotencyKeyFor('publishPost', 'k1', editor.actor),
    );
  });

  test('a call with no key carries no key attribute at all', async () => {
    const spans = await traced(() => invoke(publishPost(), { postId: 'p1' }, { ctx: editor }));
    expect('ultimate.idempotency.key' in (spans[0]?.attributes ?? {})).toBe(false);
  });
});
