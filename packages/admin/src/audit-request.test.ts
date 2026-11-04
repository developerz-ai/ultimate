// `/admin/audit`'s URL: what each parameter reads as, the builder writing back what the parser
// reads, and every parameter the screen cannot answer refused by `X_ADMIN_FILTER_INVALID` —
// `?org=` among them, because the tenant is the actor's and never the URL's.

import { describe, expect, test } from 'bun:test';
import { type AuditRequest, auditHref, auditRequestOf, historyCursorOf } from './audit-request';

const PATH = '/admin/audit';
const at = (search: string): URL => new URL(`http://localhost${PATH}${search}`);
const ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

describe('unit · the audit trail’s URL', () => {
  test('each parameter reads as its query field', () => {
    expect(
      auditRequestOf(
        at(
          `?entity=posts&actor=u_1&outcome=denied&since=2026-11-01&until=2026-11-02T12:00:00%2B02:00&changes=1&before=2026-11-01T00:00:00.000Z~${ID}`,
        ),
      ),
    ).toEqual({
      entity: 'posts',
      actorId: 'u_1',
      outcome: 'denied',
      since: '2026-11-01T00:00:00.000Z',
      until: '2026-11-02T10:00:00.000Z',
      changes: true,
      before: { at: '2026-11-01T00:00:00.000Z', id: ID },
    });
  });

  test('the form’s datetime-local minute is read as the UTC its label says, here and only here', () => {
    expect(auditRequestOf(at('?since=2026-11-01T12:00&until=2026-11-01T13:30'))).toEqual({
      since: '2026-11-01T12:00:00.000Z',
      until: '2026-11-01T13:30:00.000Z',
    });
  });

  test('no parameter is the whole trail, and an empty box is no parameter', () => {
    expect(auditRequestOf(at(''))).toEqual({});
    expect(auditRequestOf(at('?entity=&actor=&outcome=&since=&until=&before='))).toEqual({});
  });

  test('the builder writes what the parser reads, and nothing for nothing', () => {
    const request: AuditRequest = {
      entity: 'posts',
      actorId: 'u 1&2',
      outcome: 'failed',
      since: '2026-11-01T00:00:00.000Z',
      until: '2026-11-03T00:00:00.000Z',
      changes: true,
      before: { at: '2026-11-02T00:00:00.000Z', id: ID },
    };
    const href = auditHref(PATH, request);
    expect(auditRequestOf(new URL(`http://localhost${href}`))).toEqual(request);
    expect(auditHref(PATH, {})).toBe(PATH);
    expect(auditHref(PATH, { changes: false })).toBe(PATH);
  });

  test.each([
    ['?org=org-b', '"org"'],
    ['?entityId=p1', '"entityId"'],
    ['?outcome=maybe', '"outcome=maybe"'],
    ['?since=yesterday', '"since=yesterday"'],
    ['?until=2026-02-30', '"until=2026-02-30"'],
    ['?since=2026-11-01T12:00:00', '"since=2026-11-01T12:00:00"'],
    ['?changes=yes', '"changes=yes"'],
    ['?before=page-2', '"before=page-2"'],
  ])('%s is refused, naming itself and what the trail answers', (search, named) => {
    try {
      auditRequestOf(at(search));
      expect.unreachable(`${search} was answered`);
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_ADMIN_FILTER_INVALID' });
      const cause = String((error as { cause?: unknown }).cause);
      expect(cause).toContain(named);
      expect(cause).toContain(PATH);
      expect(cause).toContain('outcome=');
      // A fix that is a URL this screen answers, not the manifest command the list's refusal names.
      const fix = String((error as { fix?: unknown }).fix);
      expect(fix.startsWith(`${PATH}?outcome=denied&since=2026-11-01`)).toBe(true);
      expect(fix).not.toContain('x manifest');
      const answered = fix.slice(0, fix.indexOf(' '));
      expect(auditRequestOf(new URL(`http://localhost${answered}`)).outcome).toBe('denied');
    }
  });

  test('a row history cursor that is not one is page one there, never an error', () => {
    expect(historyCursorOf(null)).toBeUndefined();
    expect(historyCursorOf('nope')).toBeUndefined();
    expect(historyCursorOf(`not-a-date~${ID}`)).toBeUndefined();
    expect(historyCursorOf('2026-11-01T00:00:00.000Z~not-a-uuid')).toBeUndefined();
  });
});
