// The strategies over a real entity — `build`, `create` (the STORED row), `attributesFor`, the
// list forms — and what composes with them: sequences, traits, transients, callbacks, `extend`.

import { afterEach, describe, expect, test } from 'bun:test';
import { factoryWorld, orgs, posts } from './factory-fixture';
import { clearPersister } from './factory-persist';
import { testName } from './test-types';

afterEach(() => {
  clearPersister();
});

describe(testName('unit', 'factory strategies'), () => {
  test('build is the attributes only: no declared default, no timestamp, nothing written', () => {
    const { postFactory } = factoryWorld();
    const post = postFactory.build();
    expect(Object.keys(post).sort()).toEqual(['id', 'orgId', 'title']);
  });

  test('create answers the STORED row: declared defaults and timestamps filled', async () => {
    const { driver, postFactory } = factoryWorld();
    const post = await postFactory.create();
    expect(post.views).toBe(0);
    expect(post.createdAt).toBeInstanceOf(Date);
    expect(await driver.repo(posts).findById(post.id, { orgId: post.orgId })).toEqual(post);
  });

  test('attributesFor is an input: no primary key, no parent key, no transient, nothing made', async () => {
    const { driver, postFactory } = factoryWorld();
    expect(postFactory.attributesFor({ shout: true })).toEqual({ title: 'post-1' });
    expect((await driver.repo(orgs).findMany()).rows).toEqual([]);
  });

  test('buildList and createList share one sequence', async () => {
    const { postFactory } = factoryWorld();
    const built = postFactory.buildList(2);
    const created = await postFactory.createList(2);
    expect([...built, ...created].map((post) => post.title)).toEqual([
      'post-1',
      'post-2',
      'post-3',
      'post-4',
    ]);
  });

  test('reset replays the same rows, parents included', () => {
    const { postFactory } = factoryWorld();
    const first = postFactory.build();
    postFactory.reset();
    expect(postFactory.build()).toEqual(first);
  });
});

describe(testName('unit', 'factory traits, transients and callbacks'), () => {
  test('a trait may set a column the defaults leave to the entity', async () => {
    const { postFactory } = factoryWorld();
    const [, second] = await postFactory.with('popular').createList(2);
    // The post's own sequence: the org each one made draws from the org factory's.
    expect(second?.views).toBe(200);
  });

  test('a transient reaches the callback and never the row', () => {
    const { postFactory } = factoryWorld();
    const post = postFactory.build({ shout: true });
    expect(post.title).toBe('POST-1');
    expect('shout' in post).toBe(false);
  });

  test('afterCreate sees the stored row and its children', async () => {
    const { postFactory } = factoryWorld();
    const seen: unknown[] = [];
    const tracked = postFactory.extend({
      afterCreate: (row) => void seen.push([row.views, row.comments.length]),
    });
    await tracked.create({ comments: 1 });
    expect(seen).toEqual([[0, 1]]);
    // A build never runs it.
    tracked.build();
    expect(seen).toHaveLength(1);
  });
});

describe(testName('unit', 'factory extend'), () => {
  test('a child factory overrides defaults, adds traits and keeps the parent sequence', () => {
    const { postFactory } = factoryWorld();
    const drafts = postFactory.extend({
      defaults: (n) => ({ title: `draft-${n}` }),
      traits: { viral: { views: 1_000_000 } },
    });
    const base = postFactory.build();
    const draft = drafts.with('viral', 'titled').build();
    expect([base.title, draft.title, draft.views]).toEqual(['post-1', 'titled', 1_000_000]);
    expect(drafts.build().title).toBe('draft-3');
    expect(drafts.traits).toEqual(['popular', 'titled', 'viral']);
  });

  test('a child chains its afterBuild after the parent', () => {
    const { postFactory } = factoryWorld();
    const loud = postFactory.extend({
      afterBuild: (row) => {
        row.title = `${row.title}!`;
      },
    });
    expect(loud.build({ shout: true }).title).toBe('POST-1!');
  });
});
