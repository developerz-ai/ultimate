// URL ⇄ the slice of the audit trail `/admin/audit` is asked for. The screen's whole state lives in
// its query string, as a list's does (`list-request.ts`): the filter form is a native GET and the
// older link is a URL. One parser and one builder, so the two cannot disagree about a name. A
// parameter the screen does not answer is REFUSED — never the unfiltered trail.
//
//   ?entity=<name>  ?actor=<id>  ?outcome=<allowed|denied|failed>  ?changes=1
//   ?since=<instant>  ?until=<instant>   ISO-8601 with an offset, YYYY-MM-DD as UTC, or the
//                                        form's YYYY-MM-DDTHH:mm, given the Z its UTC label states
//   ?before=<at>~<id>                    keyset: the entry the previous page ended on
//
// An EMPTY value is no parameter at all: a GET form submits every input it holds. `orgId` is
// never a parameter — it is the actor's (`screen-system.tsx`), so `?org=` is unknown and a 400.

import type { AuditCursor, AuditOutcome, AuditQuery } from './audit';
import { AdminFilterInvalidError } from './errors';
import { utcFormInstantOf } from './list-filters';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The query parameter an older page of a row's history is asked for by: `?history=<at>~<id>`. */
export const HISTORY_PARAM = 'history';

/** The cursor as one parameter value — an ISO instant holds no `~`, a uuid neither. */
export const historyCursorText = (cursor: AuditCursor): string => `${cursor.at}~${cursor.id}`;

/** A posted-back cursor, or `undefined` for anything that is not one: page one, never an error. */
export function historyCursorOf(raw: string | null): AuditCursor | undefined {
  if (raw === null) return undefined;
  const at = raw.indexOf('~');
  if (at <= 0) return undefined;
  const instant = raw.slice(0, at);
  const id = raw.slice(at + 1);
  // A uuid, because the durable log compares it as one: anything else would be a cast error from
  // the database where a hand-edited URL deserves page one.
  return Number.isNaN(Date.parse(instant)) || !UUID.test(id) ? undefined : { at: instant, id };
}

export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['allowed', 'denied', 'failed'];

/** The parameter names, in the order the builder writes them. */
export const AUDIT_PARAMS = [
  'entity',
  'actor',
  'outcome',
  'since',
  'until',
  'changes',
  'before',
] as const;

/**
 * The refusal's fix: a URL at the screen's own path (`basePath` included) that it answers, with
 * every parameter it reads named beside it.
 */
export const auditUrlFix = (path: string): string =>
  `${path}?outcome=denied&since=2026-11-01   # keep only entity, actor, outcome (allowed|denied|failed), since, until (YYYY-MM-DD or ISO-8601 with an offset), changes=1, before; drop every other parameter`;

type AuditParam = (typeof AUDIT_PARAMS)[number];

/** What a URL may ask of the trail: `AuditQuery` minus the actor's tenant and the page size. */
export type AuditRequest = Pick<
  AuditQuery,
  'entity' | 'actorId' | 'outcome' | 'since' | 'until' | 'changes' | 'before'
>;

const isParam = (key: string): key is AuditParam =>
  (AUDIT_PARAMS as readonly string[]).includes(key);

/** The trail a URL asks for. Throws `X_ADMIN_FILTER_INVALID` for anything it cannot read. */
export function auditRequestOf(url: URL): AuditRequest {
  const refuse = (asked: string, cause: string): never => {
    throw new AdminFilterInvalidError({
      entity: url.pathname,
      asked,
      cause,
      known: AUDIT_PARAMS.map((name) => `${name}=`),
      fix: auditUrlFix(url.pathname),
    });
  };
  const out: { -readonly [K in keyof AuditRequest]: AuditRequest[K] } = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key).filter((value) => value !== '');
    const last = values[values.length - 1];
    if (!isParam(key)) refuse(key, 'is not a parameter the audit trail reads');
    if (last === undefined) continue;
    const asked = `${key}=${last}`;
    switch (key) {
      case 'entity':
        out.entity = last;
        break;
      case 'actor':
        out.actorId = last;
        break;
      case 'outcome':
        out.outcome =
          AUDIT_OUTCOMES.find((known) => known === last) ??
          refuse(asked, `is not an outcome (${AUDIT_OUTCOMES.join(', ')})`);
        break;
      case 'since':
      case 'until':
        out[key] =
          utcFormInstantOf(last) ??
          refuse(asked, 'is neither an ISO-8601 instant with an offset nor a YYYY-MM-DD date');
        break;
      case 'changes':
        out.changes = last === '1' || refuse(asked, 'takes 1, or is left out');
        break;
      case 'before':
        out.before =
          historyCursorOf(last) ?? refuse(asked, 'is not a position this trail wrote (<at>~<id>)');
        break;
    }
  }
  return out;
}

/** The URL of one slice of the trail, rooted at the screen's own path. */
export function auditHref(path: string, request: AuditRequest): string {
  const query = new URLSearchParams();
  if (request.entity !== undefined) query.set('entity', request.entity);
  if (request.actorId !== undefined) query.set('actor', request.actorId);
  if (request.outcome !== undefined) query.set('outcome', request.outcome);
  if (request.since !== undefined) query.set('since', request.since);
  if (request.until !== undefined) query.set('until', request.until);
  if (request.changes === true) query.set('changes', '1');
  if (request.before !== undefined) query.set('before', historyCursorText(request.before));
  const search = query.toString();
  return search === '' ? path : `${path}?${search}`;
}
