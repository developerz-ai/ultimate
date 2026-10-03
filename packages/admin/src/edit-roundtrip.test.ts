// The edit form round trip, as an operator does it: GET the form, change one field, POST it back.
// An instant the form can only show to the minute is NOT rewritten at the minute (the reproduced
// `10:20:45.123` → `10:20:00.000`), and a row someone else changed after the form was rendered is
// refused with a 409 instead of being overwritten with the stale copy.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  memoryDriver,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import {
  defineRoles,
  knownPermissions,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';
import { ROW_CHANGED_REASON, VERSION_FIELD } from './row-version';
import type { AdminRouteResponse } from './screen-frame';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();

const articles = entity('admin_roundtrip_articles', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    publishedAt: timestamp().nullable(),
  },
});

const STORED = new Date('2026-03-01T10:20:45.123Z');
const db = database({ articles }, { driver: memoryDriver() });
let admin: AdminApp;

beforeAll(() => {
  admin = defineAdmin({ entities: [articles], db });
  defineRoles({
    ...previousRoles,
    editor: {
      grants: [
        'admin:read',
        'admin:write',
        'admin_roundtrip_articles:read',
        'admin_roundtrip_articles:write',
      ],
    },
  });
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions);
  clearRegistry();
});

const respond = (
  path: string,
  form?: Readonly<Record<string, unknown>>,
): Promise<{ readonly response: AdminRouteResponse; readonly html: string }> =>
  runWithContext(
    createContext({ actor: userActor({ id: 'u-ed', roles: ['editor'] }), tz: 'UTC', locale: 'en' }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(admin, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
      const response = await matched.route.respond({
        ctx: await admin.requestCtx(new Request(url)),
        params: matched.params,
        url,
        method: form === undefined ? 'GET' : 'POST',
        form: form ?? null,
      });
      const html =
        response.kind === 'document'
          ? await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx')
          : '';
      return { response, html };
    },
  );

/** What a browser posts back: every named control the form rendered, as rendered. */
const renderedForm = (html: string): Record<string, string> => {
  const form: Record<string, string> = {};
  for (const match of html.matchAll(/<input[^>]*>/g)) {
    const tag = match[0];
    const name = /name="([^"]*)"/.exec(tag)?.[1];
    if (name === undefined || name === 'term') continue;
    form[name] = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
  }
  return form;
};

const editPath = (id: string): string => `/admin/admin_roundtrip_articles/${id}/edit`;

describe('unit · the edit round trip', () => {
  test('a title-only edit leaves the instant as stored — and the audit diff says title', async () => {
    const row = await db.articles.insert({ title: 'Draft', publishedAt: STORED });
    const shown = renderedForm((await respond(editPath(row.id))).html);
    expect(shown['publishedAt']).toBe('2026-03-01T10:20');
    expect(shown[VERSION_FIELD]).toBeString();

    const posted = await respond(editPath(row.id), { ...shown, title: 'Final' });
    expect(posted.response.kind).toBe('redirect');
    const stored = await db.articles.where({ id: row.id }).one();
    expect(stored?.title).toBe('Final');
    expect(stored?.publishedAt?.toISOString()).toBe(STORED.toISOString());
    const [entry] = await admin.audit.entries({ entityId: row.id, changes: true, limit: 1 });
    expect(entry?.diff.map((change) => change.field)).toEqual(['title']);
  });

  test('a row changed after the form was rendered is a 409, and the other edit stands', async () => {
    const row = await db.articles.insert({ title: 'Shared', publishedAt: null });
    const shown = renderedForm((await respond(editPath(row.id))).html);
    // Someone else, between this operator's GET and their POST.
    await db.articles.update(row.id, { title: 'Theirs' });

    const posted = await respond(editPath(row.id), { ...shown, title: 'Mine' });
    expect(posted.response.kind === 'document' ? posted.response.status : 0).toBe(409);
    expect((await db.articles.where({ id: row.id }).one())?.title).toBe('Theirs');
    const [entry] = await admin.audit.entries({ entityId: row.id, limit: 1 });
    expect(entry).toMatchObject({ outcome: 'failed', reason: ROW_CHANGED_REASON });

    // The refusal re-renders against the row as it is NOW: posting it again is a decision.
    const again = renderedForm(posted.html);
    expect(again[VERSION_FIELD]).not.toBe(shown[VERSION_FIELD]);
    expect((await respond(editPath(row.id), { ...again, title: 'Mine' })).response.kind).toBe(
      'redirect',
    );
    expect((await db.articles.where({ id: row.id }).one())?.title).toBe('Mine');
  });

  test('a POST that carries no version is not a form this admin rendered: 409, nothing written', async () => {
    const row = await db.articles.insert({ title: 'Kept', publishedAt: null });
    const posted = await respond(editPath(row.id), { title: 'Forged', publishedAt: '' });
    expect(posted.response.kind === 'document' ? posted.response.status : 0).toBe(409);
    expect((await db.articles.where({ id: row.id }).one())?.title).toBe('Kept');
  });
});
