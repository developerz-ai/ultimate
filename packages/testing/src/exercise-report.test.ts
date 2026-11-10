// The exercise room attributes by the observed call's async context, never by its time window: a
// ctx-less timer's or another request's statement, row, mail or dial made while the call awaits is
// not the call's — and the call's own un-awaited work is.

import { describe, expect, test } from 'bun:test';
import type { DbStatementEvent } from '@ultimat3/core';
import { instrument } from '@ultimat3/core';
import type { MailMessage } from '@ultimat3/mail';
import type { ExerciseRoom, Observed } from './exercise-report';
import { openExerciseRoom } from './exercise-report';
import { judgeScale } from './scale-sweep';
import { testName } from './test-types';

const statement = (entity: string, op: string): DbStatementEvent => ({
  text: `select * from ${entity}`,
  values: [],
  durationMs: 0,
  rows: 0,
  attribution: { entity, op },
});

const emit = (entity: string, op: string): void =>
  instrument('db.statement', statement(entity, op));

const message = (mailId: string): MailMessage => ({
  mailId,
  to: ['a@x.example'],
  subject: 'subject',
  html: '<p>hi</p>',
  text: 'hi',
  locale: 'en',
  tz: 'UTC',
});

/** One query's call: its own read, and nothing else. */
const listPosts = async (): Promise<void> => {
  emit('posts', 'findMany');
};

/**
 * The same read, then the call holds its window open until `neighbour` has acted — so the
 * neighbour's work lands INSIDE the window by construction, with no wall-clock wait to race. What
 * the neighbour runs in is whatever context it was armed in, which is the point of each test.
 */
const listPostsWhile =
  (gate: { readonly resolve: () => void }, neighbour: Promise<unknown>) =>
  async (): Promise<void> => {
    emit('posts', 'findMany');
    gate.resolve();
    await neighbour;
  };

const observed = async (room: ExerciseRoom, fn: () => Promise<unknown>): Promise<Observed> => {
  const seen = await room.observe('listPosts', fn);
  if ('error' in seen) return expect.unreachable('the observed call answered');
  return seen.observed;
};

const fingerprints = (seen: Observed): readonly string[] =>
  seen.shapes.map((shape) => shape.fingerprint);

describe(testName('unit', 'openExerciseRoom'), () => {
  test('a ctx-less timer firing in the window is not the call’s: the scale proof stays flat', async () => {
    await using room = await openExerciseRoom();
    const small = await observed(room, listPosts);
    // Armed outside the call, as a module-scope interval or a cache sweeper would be.
    const gate = Promise.withResolvers<void>();
    const stray = gate.promise.then(() => emit('hosts', 'findMany'));
    const large = await observed(room, listPostsWhile(gate, stray));
    expect(fingerprints(large)).toEqual(['posts.findMany']);
    expect(large.statements).toBe(1);
    expect(judgeScale(small.shapes, large.shapes)).toEqual({ verdict: 'flat', expected: [] });
  });

  test('another request’s statement in the window is not the call’s', async () => {
    const { withRequestAs } = await import('@ultimat3/http');
    await using room = await openExerciseRoom();
    const gate = Promise.withResolvers<void>();
    const other = withRequestAs('other', null, undefined, async () => {
      await gate.promise;
      emit('hosts', 'findMany');
    });
    const seen = await observed(room, listPostsWhile(gate, other));
    expect(fingerprints(seen)).toEqual(['posts.findMany']);
  });

  test('the call’s own un-awaited background work is the call’s', async () => {
    await using room = await openExerciseRoom();
    const seen = await observed(room, async () => {
      // Started by the call and never awaited by it: the call only waits for a signal the
      // background work raises, so the work's own promise chain is not the call's await chain.
      const gate = Promise.withResolvers<void>();
      const landed = Promise.withResolvers<void>();
      void gate.promise.then(() => {
        emit('posts', 'count');
        landed.resolve();
      });
      await listPosts();
      gate.resolve();
      await landed.promise;
    });
    expect([...fingerprints(seen)].sort()).toEqual(['posts.count', 'posts.findMany']);
  });

  test('the plan sweep is handed only the statements the subject sent', async () => {
    await using room = await openExerciseRoom();
    const gate = Promise.withResolvers<void>();
    const stray = gate.promise.then(() => emit('hosts', 'findMany'));
    await observed(room, listPostsWhile(gate, stray));
    expect([...room.sent()].map(([, one]) => [...one.primitives])).toEqual([['listPosts']]);
    expect([...room.sent().keys()]).toEqual(['select * from posts']);
  });

  test('a row, a mail and a dial from outside the call are not its effects; its own are', async () => {
    const { mailDriver } = await import('@ultimat3/mail');
    await using room = await openExerciseRoom();
    const gate = Promise.withResolvers<void>();
    const strangers = gate.promise.then(async () => {
      instrument('entity.row', { entity: 'hosts', op: 'insert', before: null, after: {} });
      instrument('entity.bulk', { entity: 'hosts', op: 'delete', rows: 3 });
      await mailDriver().send(message('stranger'));
      await fetch('https://stranger.example/').catch(() => undefined);
    });
    const seen = await observed(room, async () => {
      instrument('entity.row', { entity: 'posts', op: 'insert', before: null, after: {} });
      await mailDriver().send(message('receipt'));
      await fetch('https://vendor.example/').catch(() => undefined);
      gate.resolve();
      await strangers;
    });
    expect(seen.effects).toEqual([
      { kind: 'row', entity: 'posts', op: 'insert', rows: 1 },
      { kind: 'mail', mail: 'receipt', count: 1 },
      { kind: 'network', method: 'GET', host: 'vendor.example', refused: true },
    ]);
    expect(seen.refusedHosts).toEqual(['vendor.example']);
    expect(seen.payloads.map((payload) => payload.path)).toEqual([
      'effect.mail[0]',
      'effect.network[0]',
    ]);
  });

  test('a straggler of the call before is not the next call’s', async () => {
    await using room = await openExerciseRoom();
    const gate = Promise.withResolvers<void>();
    let straggler: Promise<void> = Promise.resolve();
    await observed(room, async () => {
      // Armed inside the first call and left running past its end.
      straggler = gate.promise.then(() => emit('posts', 'count'));
    });
    const next = await observed(room, listPostsWhile(gate, straggler));
    expect(fingerprints(next)).toEqual(['posts.findMany']);
  });

  test('a throw is handed back beside what the call did before it', async () => {
    await using room = await openExerciseRoom();
    const seen = await room.observe(undefined, async () => {
      emit('posts', 'findMany');
      // The call's own failure, as an app's would surface: a parse that refuses its input.
      return JSON.parse('not json');
    });
    expect('error' in seen && seen.error instanceof SyntaxError).toBe(true);
    expect(seen.observed.statements).toBe(1);
    expect(room.owns()).toBe(false);
  });
});
