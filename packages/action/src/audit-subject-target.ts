// `auditSubjectTarget()`: `x_audit` as a subject target a `defineSubject({ targets })` lists —
// structural, so `@ultimat3/jobs` (this tier) imports nothing from here. The erase never deletes a
// trail row: it overwrites who acted (`actor_id`, `on_behalf_of_id`) and the input they sent, so
// the record of WHAT happened stays. An app that must keep the person too lists it `{ retain }`.

import type { PgExecutor } from '@ultimat3/core';

/** The subject as a target is handed it: the key asked for, and the subject's row read fresh. */
export interface AuditSubjectRef {
  readonly key: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface AuditSubjectTargetOptions {
  readonly executor: PgExecutor;
  /** The `actor_id` the subject acted as. Default: the subject's key. `undefined` touches nothing. */
  readonly actor?: (subject: AuditSubjectRef) => string | undefined;
  /** What replaces the actor. Default `'erased'`: a fixed word, never derived from the person. */
  readonly placeholder?: string;
}

type Cell = string | number | boolean | null;

export interface AuditSubjectTarget {
  readonly name: 'x_audit';
  readonly columns: readonly string[];
  exportPage(
    subject: AuditSubjectRef,
    cursor: string | null,
    size: number,
  ): Promise<{
    readonly rows: readonly Readonly<Record<string, Cell>>[];
    readonly cursor: string | null;
  }>;
  erase(subject: AuditSubjectRef, size: number): Promise<number>;
}

export const AUDIT_SUBJECT_COLUMNS = [
  'id',
  'at',
  'action',
  'primitive',
  'surface',
  'outcome',
  'org_id',
] as const;

// Keyset on the uuid v7 id, which is time-ordered: a page resumes where the last one ended.
const SQL_PAGE = `select id::text as id, at::text as at, action, primitive, surface, outcome, org_id
  from x_audit where (actor_id = $1 or on_behalf_of_id = $1)
  and ($2::uuid is null or id > $2::uuid) order by id limit $3`;

// Bounded: one statement rewrites at most `size` rows, and a replay finds none left to rewrite.
const SQL_ERASE = `update x_audit set
  actor_id = case when actor_id = $1 then $2 else actor_id end,
  on_behalf_of_id = case when on_behalf_of_id = $1 then $2 else on_behalf_of_id end,
  input = null
  where id in (select id from x_audit where actor_id = $1 or on_behalf_of_id = $1 limit $3)
  returning id`;

export function auditSubjectTarget(options: AuditSubjectTargetOptions): AuditSubjectTarget {
  const { executor } = options;
  const actorOf = options.actor ?? ((subject: AuditSubjectRef) => subject.key);
  const placeholder = options.placeholder ?? 'erased';
  return {
    name: 'x_audit',
    columns: AUDIT_SUBJECT_COLUMNS,
    async exportPage(subject, cursor, size) {
      const actor = actorOf(subject);
      if (actor === undefined) return { rows: [], cursor: null };
      const rows = await executor.query<Record<string, Cell>>(SQL_PAGE, [actor, cursor, size]);
      const last = rows.at(-1)?.['id'];
      return { rows, cursor: rows.length < size || typeof last !== 'string' ? null : last };
    },
    async erase(subject, size) {
      const actor = actorOf(subject);
      if (actor === undefined) return 0;
      return (await executor.query(SQL_ERASE, [actor, placeholder, size])).length;
    },
  };
}
