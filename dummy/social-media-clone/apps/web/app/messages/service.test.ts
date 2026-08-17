// unit — the thread list, over more than one thread. The list used to read members and names once
// per conversation, so nothing caught a grouping mistake: with one read per thread there is nothing
// to group. Now there are two statements for the whole screen, and the failure they can have is
// putting one thread's people on another thread's row.

import { beforeAll, expect, test } from 'bun:test';
import { db } from '@social-media-clone/db';
import { membersOfMany } from './repo';
import { threadsFor } from './service';

const VIEWER = '00000000-0000-4000-8000-0000000000f1';
const RIA = '00000000-0000-4000-8000-0000000000f2';
const SAM = '00000000-0000-4000-8000-0000000000f3';
const NOW = new Date('2026-08-11T12:00:00Z');

let withRia = '';
let withSam = '';

const person = (id: string, handle: string) => ({
  id,
  handle,
  email: `${handle}@fixture.example`,
  displayName: handle,
  role: 'member' as const,
  createdAt: NOW,
  updatedAt: NOW,
});

beforeAll(async () => {
  for (const [id, handle] of [
    [VIEWER, 'threads_viewer'],
    [RIA, 'threads_ria'],
    [SAM, 'threads_sam'],
  ] as const) {
    await db.users.insert(person(id, handle));
  }
  // Two DIRECT threads with one member each besides the viewer: the case where a grouping bug
  // shows up as the wrong name rather than as a missing one.
  for (const other of [RIA, SAM]) {
    const conversation = await db.conversations.insert({ kind: 'direct', title: null });
    await db.participants.insert({ conversationId: conversation.id, userId: VIEWER });
    await db.participants.insert({ conversationId: conversation.id, userId: other });
    await db.messages.insert({
      conversationId: conversation.id,
      authorId: other,
      body: `hello from ${other}`,
    });
    if (other === RIA) withRia = conversation.id;
    else withSam = conversation.id;
  }
});

test('members are grouped by their own conversation, not merged across the list', async () => {
  const grouped = await membersOfMany([withRia, withSam]);
  expect(
    grouped
      .get(withRia)
      ?.map((row) => row.userId)
      .sort(),
  ).toEqual([VIEWER, RIA].sort());
  expect(
    grouped
      .get(withSam)
      ?.map((row) => row.userId)
      .sort(),
  ).toEqual([VIEWER, SAM].sort());
});

test('every thread in the list names its own other person', async () => {
  const threads = await threadsFor(VIEWER);
  const named = new Map(threads.map((thread) => [thread.conversationId, thread.otherNames]));

  expect(named.get(withRia)).toEqual(['threads_ria']);
  expect(named.get(withSam)).toEqual(['threads_sam']);
  // The viewer is never in their own thread's names — that is what `otherIds` is for.
  expect(threads.flatMap((thread) => thread.otherNames)).not.toContain('threads_viewer');
});

test('an id nobody is a member of groups to nothing, rather than to somebody else', async () => {
  const grouped = await membersOfMany(['00000000-0000-4000-8000-0000000000ff']);
  expect(grouped.size).toBe(0);
});
