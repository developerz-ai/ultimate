// The sync target a rendered document hands the page: `<meta>` names are core's, the URL resolves
// against the page, and the scheme becomes the socket's.

import { describe, expect, test } from 'bun:test';
import { CLIENT_BUILD_META, CLIENT_SYNC_META, CLIENT_SYNC_WORKER_META } from '@ultimat3/core';
import { type MetaDocument, syncTargetFromMeta, syncWorkerFromMeta } from './sync-meta';

function doc(tags: Readonly<Record<string, string>>): MetaDocument {
  return {
    querySelector: (selector) => {
      const name = /name="([^"]+)"/.exec(selector)?.[1] ?? '';
      const content = tags[name];
      return content === undefined ? null : { getAttribute: () => content };
    },
  };
}

describe('syncTargetFromMeta', () => {
  test('a same-origin path on https dials wss on the same host, with the build', () => {
    const tags = { [CLIENT_SYNC_META]: '/_x/sync', [CLIENT_BUILD_META]: 'b1' };
    expect(syncTargetFromMeta(doc(tags), 'https://app.test/feed')).toEqual({
      url: 'wss://app.test/_x/sync',
      buildId: 'b1',
    });
  });

  test('http becomes ws, and an absolute ws(s) URL stays as the deployment wrote it', () => {
    expect(syncTargetFromMeta(doc({ [CLIENT_SYNC_META]: '/_x/sync' }), 'http://l:3000/')?.url).toBe(
      'ws://l:3000/_x/sync',
    );
    const absolute = doc({ [CLIENT_SYNC_META]: 'wss://sync.app.test/_x/sync' });
    expect(syncTargetFromMeta(absolute, 'https://app.test/')?.url).toBe(
      'wss://sync.app.test/_x/sync',
    );
  });

  test('no sync meta is no target — a page with no realtime', () => {
    expect(syncTargetFromMeta(doc({}), 'https://app.test/')).toBeUndefined();
  });

  test('the worker URL resolves against the page, and is absent when none was built', () => {
    const tags = { [CLIENT_SYNC_WORKER_META]: '/_x/sync-worker/abc.js' };
    expect(syncWorkerFromMeta(doc(tags), 'https://app.test/x')).toBe(
      'https://app.test/_x/sync-worker/abc.js',
    );
    expect(syncWorkerFromMeta(doc({}), 'https://app.test/x')).toBeUndefined();
  });
});
