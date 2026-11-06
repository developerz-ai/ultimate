// `subjects` under `x manifest diff`: a subject removed, or a table's treatment moving from kept
// (`retain`, `anonymize`) to `delete`, is breaking — an erase that destroys rows the last release
// kept cannot be taken back. A subject or a reached table added is additive; the rest internal.

import type { ManifestChange } from './diff-change';
import { diffScalar, index } from './diff-change';
import type { SubjectFact, SubjectTableFact } from './schema-subjects';

function diffTables(
  path: string,
  before: readonly SubjectTableFact[],
  after: readonly SubjectTableFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByEntity = index(after, (table) => table.entity);
  const beforeByEntity = index(before, (table) => table.entity);
  for (const table of before) {
    const at = `${path}.tables.${table.entity}`;
    const next = afterByEntity.get(table.entity);
    if (next === undefined) {
      changes.push({
        kind: 'internal',
        path: at,
        detail: 'table no longer reached by the subject',
      });
      continue;
    }
    if (table.treatment !== 'delete' && next.treatment === 'delete') {
      changes.push({
        kind: 'breaking',
        path: `${at}.treatment`,
        detail: `${table.treatment} -> delete: an erase now destroys rows it used to keep`,
      });
    } else {
      changes.push(...diffScalar('internal', `${at}.treatment`, table.treatment, next.treatment));
    }
    changes.push(
      ...diffScalar('internal', `${at}.columns`, table.columns?.join(','), next.columns?.join(',')),
      ...diffScalar('internal', `${at}.reason`, table.reason, next.reason),
    );
  }
  for (const table of after) {
    if (!beforeByEntity.has(table.entity)) {
      changes.push({
        kind: 'additive',
        path: `${path}.tables.${table.entity}`,
        detail: 'table added',
      });
    }
  }
  return changes;
}

export function diffSubjects(
  before: readonly SubjectFact[],
  after: readonly SubjectFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByEntity = index(after, (subject) => subject.entity);
  const beforeByEntity = index(before, (subject) => subject.entity);
  for (const subject of before) {
    const path = `subjects.${subject.entity}`;
    const next = afterByEntity.get(subject.entity);
    if (next === undefined) {
      changes.push({
        kind: 'breaking',
        path,
        detail: "subject removed; a person's export and erase no longer exist",
      });
      continue;
    }
    changes.push(...diffScalar('internal', `${path}.batch`, subject.batch, next.batch));
    changes.push(...diffTables(path, subject.tables, next.tables));
    const targets = (s: SubjectFact): string =>
      s.targets.map((t) => `${t.name}${t.retained ? ':retained' : ''}`).join(',');
    changes.push(...diffScalar('internal', `${path}.targets`, targets(subject), targets(next)));
  }
  for (const subject of after) {
    if (!beforeByEntity.has(subject.entity)) {
      changes.push({
        kind: 'additive',
        path: `subjects.${subject.entity}`,
        detail: 'subject added',
      });
    }
  }
  return changes;
}
