import { describe, expect, test } from 'bun:test';
import { isSchemaError, ValidationFailedError } from './errors';
import { parse, validate } from './standard';
import { t } from './t';

const publishPost = t.object({
  postId: t.uuid,
  notify: t.boolean.default(true),
  title: t.string.min(3).max(80),
  tags: t.array(t.slug),
  scheduledAt: t.optional(t.date),
});

describe('t', () => {
  test('parses a valid payload and applies defaults', () => {
    const value = parse(publishPost, {
      postId: '018f4a1c-1b2c-7d3e-8f90-abcdef012345',
      title: 'Hello world',
      tags: ['release-notes', 'v2'],
    });

    expect(value).toEqual({
      postId: '018f4a1c-1b2c-7d3e-8f90-abcdef012345',
      notify: true,
      title: 'Hello world',
      tags: ['release-notes', 'v2'],
    });
  });

  test('reports every failing field with its path and what was expected', () => {
    let caught: unknown;
    try {
      parse(
        publishPost,
        { postId: 'abc', notify: 'yes', title: 'hi', tags: ['Not A Slug'] },
        'input',
      );
    } catch (thrown) {
      caught = thrown;
    }

    expect(caught).toBeInstanceOf(ValidationFailedError);
    // Structurally an UltimateError, even though schema cannot import core.
    expect(isSchemaError(caught)).toBe(true);

    const error = caught as ValidationFailedError;
    expect(error.code).toBe('X_VALIDATION_FAILED');
    expect(error.issues.map((issue) => issue.path)).toEqual([
      'postId',
      'notify',
      'title',
      'tags[0]',
    ]);
    expect(error.issues[0]?.message).toBe('expected a uuid, received a string of 3 characters');
    expect(error.issues[3]?.message).toBe(
      'expected a slug matching ^[a-z0-9]+(?:-[a-z0-9]+)*$, received a string of 10 characters',
    );
    expect(error.format().split('\n')).toHaveLength(3);
    expect(error.format()).toContain('postId: expected a uuid, received a string of 3 characters');
    expect(error.formatIssues().split('\n')).toHaveLength(4);
  });

  test('validate never throws and returns Standard Schema results', () => {
    const good = validate(t.email, 'dev@tesote.com');
    expect(good.issues).toBeUndefined();
    if (good.issues === undefined) expect(good.value).toBe('dev@tesote.com');

    const bad = validate(t.email, 'nope');
    expect(bad.issues?.[0]?.message).toBe(
      'expected an email address, received a string of 4 characters',
    );
    expect(t.email['~standard'].version).toBe(1);
    expect(t.email['~standard'].vendor).toBe('ultimate');
  });

  test('framework formats are real validators, not annotations', () => {
    expect(parse(t.timezone, 'Europe/Prague')).toBe('Europe/Prague');
    expect(() => parse(t.timezone, 'Mars/Olympus')).toThrow(/X_VALIDATION_FAILED/);
    expect(parse(t.locale, 'es-419')).toBe('es-419');
    expect(parse(t.money, { minor: 1999, currency: 'EUR' })).toEqual({
      minor: 1999,
      currency: 'EUR',
    });
    expect(() => parse(t.money, { minor: 19.99, currency: 'EUR' })).toThrow(/X_VALIDATION_FAILED/);
    expect(() => parse(t.money, { minor: 1999, currency: 'eur' })).toThrow(/X_VALIDATION_FAILED/);
  });

  test('unknown keys are dropped so an action cannot be mass-assigned', () => {
    const value = parse(t.object({ id: t.uuid }), {
      id: '018f4a1c-1b2c-7d3e-8f90-abcdef012345',
      isAdmin: true,
    });
    expect(value).toEqual({ id: '018f4a1c-1b2c-7d3e-8f90-abcdef012345' });
  });

  test('union, enum, literal and record compose', () => {
    const status = t.enum(['draft', 'published']);
    expect(parse(status, 'draft')).toBe('draft');
    expect(() => parse(status, 'archived')).toThrow(/X_VALIDATION_FAILED/);

    const idOrSlug = t.union(t.uuid, t.slug);
    expect(parse(idOrSlug, 'hello-world')).toBe('hello-world');

    const counts = t.record(t.number.int());
    expect(parse(counts, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(parse(t.literal('post'), 'post')).toBe('post');
  });

  test('a cross-field rule lives on the schema, not in the handler', () => {
    // `endDate > startDate` used to be unrepresentable, so it moved into the handler and vanished
    // from openapi.json, the MCP tool schema, the typed client and every form binding at once.
    const booking = t.refine(t.object({ startDate: t.date, endDate: t.date }), {
      name: 'end-after-start',
      message: 'endDate must be after startDate',
      path: ['endDate'],
      check: (value) => value.endDate > value.startDate,
    });
    expect(
      parse(booking, { startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-02T00:00:00Z' }),
    ).toMatchObject({ endDate: new Date('2026-01-02T00:00:00Z') });

    const bad = validate(booking, {
      startDate: '2026-01-02T00:00:00Z',
      endDate: '2026-01-01T00:00:00Z',
    });
    expect(bad.issues?.[0]?.message).toBe('endDate must be after startDate');
    expect(bad.issues?.[0]?.path).toEqual(['endDate']);
    // The declaration, not the closure, is what a projection reads.
    expect(booking.node.refinements?.[0]?.name).toBe('end-after-start');
  });

  test('t.discriminatedUnion reports the branch the tag named', () => {
    const body = t.discriminatedUnion(
      'kind',
      t.object({ kind: t.literal('post'), slug: t.slug }),
      t.object({ kind: t.literal('page'), title: t.string.min(3) }),
    );
    expect(parse(body, { kind: 'post', slug: 'hello-world' })).toEqual({
      kind: 'post',
      slug: 'hello-world',
    });
    const issues = validate(body, { kind: 'page', title: 'hi' }).issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['title']);
  });

  test('object schemas compose with extend / pick / omit', () => {
    const base = t.object({ id: t.uuid, secret: t.string });
    const view = base.omit('secret').extend({ title: t.string });
    expect(Object.keys(view.shape).sort()).toEqual(['id', 'title']);
    expect(Object.keys(base.pick('id').shape)).toEqual(['id']);
  });
});
