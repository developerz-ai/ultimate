// unit — the friends screen's read model over the seeded graph. What it must get right is the
// PARTITION: each relationship lands in exactly the list its status and its direction name, the
// "other person" is never the viewer, and a list reads newest first.

import { beforeAll, expect, test } from 'bun:test';
import { seedDemo } from '@social-media-clone/db';
import { seedId } from '@ultimat3/entity';
import { type EdgeView, friendsScreen } from './screen';

const VIEWER = seedId('user:user');

beforeAll(async () => {
  await seedDemo();
});

const everyEdge = (screen: Awaited<ReturnType<typeof friendsScreen>>): readonly EdgeView[] => [
  ...screen.incoming,
  ...screen.outgoing,
  ...screen.friends,
  ...screen.declined,
  ...screen.blocked,
];

test('the other person is never the viewer — an inbox must not render the viewer’s own name', async () => {
  const screen = await friendsScreen(VIEWER);
  const edges = everyEdge(screen);
  expect(edges.length).toBeGreaterThan(0);
  for (const edge of edges) expect(edge.person.id).not.toBe(VIEWER);
});

test('a pending row lands by DIRECTION: asked of the viewer is incoming, asked by them is outgoing', async () => {
  const screen = await friendsScreen(VIEWER);
  for (const edge of screen.incoming) expect(edge.theyAsked).toBe(true);
  for (const edge of screen.outgoing) expect(edge.theyAsked).toBe(false);
  // The two lists are disjoint: one relationship is one row, in one place.
  const incoming = new Set(screen.incoming.map((edge) => edge.person.id));
  expect(screen.outgoing.some((edge) => incoming.has(edge.person.id))).toBe(false);
});

test('every list reads newest first', async () => {
  const screen = await friendsScreen(VIEWER);
  for (const list of [screen.incoming, screen.outgoing, screen.friends, screen.declined]) {
    const stamps = list.map((edge) => edge.at.getTime());
    expect(stamps).toEqual([...stamps].sort((left, right) => right - left));
  }
});

test('a viewer with no relationships gets five empty lists, not an error', async () => {
  const screen = await friendsScreen('00000000-0000-4000-8000-00000000f00d');
  expect(everyEdge(screen)).toEqual([]);
});
