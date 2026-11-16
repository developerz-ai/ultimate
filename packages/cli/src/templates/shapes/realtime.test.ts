// What `--shape realtime` promises, read off its planned files: nothing of the default left out, the
// room and its notifier wired into the API, and a two-node suite that needs a real bus.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../../cmd-new';
import type { GeneratedFile } from '../naming';

const files = planNewApp({ name: 'probe', example: true, shape: 'realtime' });

const textAt = (path: string): string => {
  const file = files.find((candidate) => candidate.path === path);
  return file === undefined || typeof file.contents !== 'string' ? '' : file.contents;
};

const paths = (list: readonly GeneratedFile[]): readonly string[] => list.map((file) => file.path);

describe('unit · x new --shape realtime', () => {
  test('the default app, whole, plus the room, its read, the notifier and the mutator', () => {
    const base = paths(planNewApp({ name: 'probe', example: true }));
    expect(base.filter((path) => !paths(files).includes(path))).toEqual([]);
    for (const path of [
      'apps/web/app/post/channels.ts',
      'apps/web/app/post/queries/recent-posts.ts',
      'apps/web/app/post/jobs/post-created.ts',
      'apps/web/app/post/actions/rename-post.ts',
    ]) {
      expect(paths(files)).toContain(path);
    }
  });

  test('every new primitive is registered, and createPost announces what it wrote', () => {
    const api = textAt('apps/web/api/index.ts');
    expect(api).toContain('actions: [health, createPost, archivePost, renamePost]');
    expect(api).toContain('queries: [postList, recentPosts]');
    expect(api).toContain('jobs: [reindexPost, postCreated]');
    expect(textAt('apps/web/app/post/actions/create-post.ts')).toContain(
      'await postCreated.enqueue({ params: { id: row.id, orgId: row.orgId } });',
    );
  });

  test('the room re-reads under its own rule, and the notifier publishes on it', () => {
    expect(textAt('apps/web/app/post/channels.ts')).toContain('policy: canPostWatch,');
    expect(textAt('apps/web/app/post/queries/recent-posts.ts')).toContain('policy: canPostWatch,');
    expect(textAt('apps/web/app/post/policy.ts')).toContain('export const canPostWatch');
    expect(textAt('apps/web/app/post/jobs/post-created.ts')).toContain('publishChannelEvent(');
  });

  test('two nodes on a real bus, skipped by name without one', () => {
    const live = textAt('apps/web/app/post/channels.live.test.ts');
    expect(live.match(/await node\(\)/g)?.length).toBe(2);
    expect(live).toContain('new NatsTransport(');
    expect(live).toContain("{ needs: ['nats'] }");
  });

  test('the two packages it imports are the app’s own dependencies', () => {
    const manifest = textAt('package.json');
    expect(manifest).toContain('"@ultimat3/notify": "^');
    expect(manifest).toContain('"@ultimat3/realtime": "^');
  });
});
