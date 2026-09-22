// The header's like count, through the real chunk: it reads `posts:<id>` out of the PAGE's store
// and nothing else — no read, no channel, no socket. The store here is written the way every other
// writer reaches it (core's `pageClient().store`, the one sink an answer, a frame and an overlay all
// land in), so what is proved is that a record another island moved re-renders this one.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import { pageClient } from '@ultimat3/core';
import { installRealtime } from '@ultimat3/realtime';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type MountedIsland,
  mountIsland,
  test,
} from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const ISLAND = 'apps/web/app/posts/[id]/likes-badge.island.tsx';
const POST_ID = '00000000-0000-4000-8000-0000000000c1';
const PAGE = Symbol.for('ultimate.realtime');

const PROPS = {
  postId: POST_ID,
  likeCount: 2,
  likes: { locale: 'en', forms: { one: '{count} like', other: '{count} likes' } },
} as const;

const adopt = (likeCount: number): void => {
  pageClient().store?.adopt('posts', { [POST_ID]: { id: POST_ID, likeCount } });
};

let mounted: MountedIsland;
const badge = (): string => mounted.text('[data-role="likes-badge"]');

beforeAll(async () => {
  // The page state every island shares; no sync target — this island opens no socket.
  installRealtime({
    signal: <T>(initial: T): [() => T, (next: T) => void] => {
      let held = initial;
      return [() => held, (next) => (held = next)];
    },
  });
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: PROPS,
    shell: '<span>2 likes</span>',
    globals: {
      // Refused outright: a badge that dialled the node would be the bytes this island exists
      // to avoid.
      WebSocket: class {
        constructor() {
          throw new TypeError('the likes badge must open no socket');
        }
      },
    },
  });
}, 60_000);

afterAll(() => {
  mounted?.[Symbol.dispose]();
  Reflect.deleteProperty(globalThis, PAGE);
});

describe('the likes badge', () => {
  test('shows the server’s count until the record lands', () => {
    expect(badge()).toBe('2 likes');
  });

  test('re-renders from the page store: a record another island moved moves this one too', () => {
    adopt(1);
    expect(badge()).toBe('1 like');
    adopt(7);
    expect(badge()).toBe('7 likes');
  });
});
