import { describe, expect, test } from 'bun:test';
import type { Row } from './conflict-policy';
import { resolveConflict } from './conflict-policy';

const local: Row = { id: 'p1', title: 'mine', updatedAt: 200 };
const server: Row = { id: 'p1', title: 'theirs', updatedAt: 100 };

describe('resolveConflict', () => {
  test('server-wins answers the server row even when the local one is newer', () => {
    expect(resolveConflict('server-wins', local, server)).toBe(server);
  });

  test('last-write-wins keeps the local row only when its clock is newer', () => {
    expect(resolveConflict('last-write-wins', local, server)).toBe(local);
    expect(resolveConflict('last-write-wins', server, local)).toBe(local);
  });

  test('last-write-wins with no provable clock falls back to the server row', () => {
    expect(resolveConflict('last-write-wins', { id: 'p1' }, server)).toBe(server);
    expect(resolveConflict('last-write-wins', { ...local, updatedAt: '9' }, server)).toBe(server);
    const bare: Row = { id: 'p1' };
    expect(resolveConflict('last-write-wins', local, bare)).toBe(bare);
  });

  test('last-write-wins reads the declared clock field, never a prototype member', () => {
    const at = { clockField: 'rev' };
    expect(resolveConflict('last-write-wins', { rev: 3 }, { rev: 2 }, at)).toEqual({ rev: 3 });
    const proto = { clockField: 'constructor' };
    expect(resolveConflict('last-write-wins', { id: 'a' }, { id: 'b' }, proto)).toEqual({
      id: 'b',
    });
  });

  test('custom receives the two ROWS, local first, and its answer survives', () => {
    const calls: [Row, Row][] = [];
    const merged = resolveConflict(
      {
        kind: 'custom',
        merge: (mine, theirs) => {
          calls.push([mine, theirs]);
          return { ...theirs, title: `${String(mine['title'])}+${String(theirs['title'])}` };
        },
      },
      local,
      server,
    );
    expect(calls).toEqual([[local, server]]);
    expect(merged).toEqual({ id: 'p1', title: 'mine+theirs', updatedAt: 100 });
  });
});
