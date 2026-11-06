// The id half of an exercise input: which field names an entity, which seeded row it binds to,
// and that binding walks the drawn value without touching what it does not name.

import { describe, expect, test } from 'bun:test';
import {
  bindIds,
  entityForStem,
  entityForSubject,
  idStem,
  namesActorEntity,
  seededIds,
} from './exercise-input';
import type { SeedGraph, SeedRow } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';
import { testName } from './test-types';

const named = (name: string): SeedEntity =>
  ({ $name: name, $table: name, $primaryKey: ['id'] }) as unknown as SeedEntity;
const posts = named('posts');
const endpoints = named('webhook_endpoints');
const runEvents = named('run_events');
const members = named('members');

const graphOf = (inserts: readonly SeedRow[]): SeedGraph => ({
  seed: 1,
  tenants: ['t1'],
  order: [],
  inserts,
  updates: [],
  canaries: [],
});
const row = (entity: string, values: Record<string, unknown>): SeedRow => ({
  entity,
  table: entity,
  tenant: 't1',
  row: values,
});

describe(testName('unit', 'exercise input'), () => {
  test('a stem is read off camel and snake id fields; a bare id names nothing', () => {
    expect(idStem('postId')).toBe('post');
    expect(idStem('blog_post_id')).toBe('blog_post');
    expect(idStem('id')).toBeUndefined();
    expect(idStem('paid')).toBeUndefined();
  });

  test('a stem names an entity exactly, else the one entity whose name ends with it', () => {
    expect(entityForStem('post', [posts, endpoints])).toBe(posts);
    expect(entityForStem('endpoint', [posts, endpoints])).toBe(endpoints);
    // Two tables end with it: no guess.
    expect(entityForStem('event', [runEvents, named('post_events')])).toBeUndefined();
  });

  test('a bare id names the entity the primitive is named after; a tie names none', () => {
    expect(entityForSubject('movePostStatus', [posts, members])).toBe(posts);
    expect(entityForSubject('linkNoteTask', [named('notes'), named('tasks')])).toBeUndefined();
  });

  test('a row owned by the actor first, then anyone but the actor, the actor last', () => {
    const graph = graphOf([
      row('members', { id: 'me' }),
      row('members', { id: 'other' }),
      row('posts', { id: 'p-theirs', authorId: 'other' }),
      row('posts', { id: 'p-mine', authorId: 'me' }),
    ]);
    const lookup = seededIds(graph, [posts, members], {
      tenant: 't1',
      actorId: 'me',
      subject: 'x',
    });
    expect(lookup('postId')?.value).toBe('p-mine');
    expect(lookup('memberId')?.value).toBe('other');
    const scope = { tenant: 't1', actorId: 'me', subject: 'x', actorEntity: 'members' };
    const self = seededIds(graph, [posts, members], { ...scope, self: true });
    const other = seededIds(graph, [posts, members], { ...scope, self: false });
    expect([self('memberId')?.value, other('memberId')?.value]).toEqual(['me', 'other']);
    expect(namesActorEntity({ memberId: 'x' }, [members], scope)).toBe(true);
    expect(namesActorEntity({ postId: 'x' }, [posts, members], scope)).toBe(false);
  });

  // The scaffold's `archivePost` takes `{ id, orgId }` and `canPostWrite` compares `orgId` with the
  // actor's: any other id is X_FORBIDDEN, and a fresh `x new` app is red on its first gate.
  test('a tenant column field is the tenant, even with no entity of that name', () => {
    const tenanted = { ...named('posts'), $tenantColumn: 'orgId' } as SeedEntity;
    const graph = graphOf([row('posts', { id: 'p1', orgId: 't1' })]);
    const lookup = seededIds(graph, [tenanted], { tenant: 't1', subject: 'archivePost' });
    expect([lookup('orgId')?.value, lookup('id')?.value]).toEqual(['t1', 'p1']);
    expect(seededIds(graph, [posts], { tenant: 't1', subject: 'x' })('orgId')).toBeUndefined();
  });

  test('every string id field is bound, nested ones too; anything else is left as drawn', () => {
    const lookup = (key: string) =>
      key === 'postId' ? { found: true as const, value: 'p1' } : undefined;
    const drawn = { postId: 'x', title: 'sample', inner: { postId: 'y' }, count: 1 };
    expect(bindIds(drawn, lookup)).toEqual({
      postId: 'p1',
      title: 'sample',
      inner: { postId: 'p1' },
      count: 1,
    });
  });
});
