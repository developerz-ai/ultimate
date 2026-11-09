// The subject proof under the `exercise` step. Static: every `defineSubject()` planned against
// every registered entity — a table keyed to the subject with no treatment is
// `X_SUBJECT_TABLE_UNDECLARED` naming it, so "you forgot last month's table" is a red gate.
// Dynamic: `subjectProof` erases one generated person and searches every table for them.

import { isUltimateError } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { identifier, sql } from '@ultimat3/db';
import type { EntityCore, RegistryEntry } from '@ultimat3/entity';
import type { Subject } from '@ultimat3/jobs';
import { planSubject } from '@ultimat3/jobs';
import type { SeedFactory, SeedGraph } from '@ultimat3/testing';
import { entitySeedWriter, subjectProof } from '@ultimat3/testing';
import type { Finding } from './output';

export function subjectFindings(
  subjects: readonly Subject<never>[],
  entries: readonly RegistryEntry[],
): readonly Finding[] {
  return subjects.flatMap((subject) =>
    planSubject({
      subject: subject.entity,
      tables: subject.init.tables,
      columns: subject.init.columns,
      entries,
    }).problems.flatMap((problem): Finding[] =>
      isUltimateError(problem)
        ? [{ code: problem.code, cause: problem.cause, fix: problem.fix, at: subject.entity }]
        : [],
    ),
  );
}

/**
 * The dynamic half: each declared subject erased on its own generated graph, on the pass's scratch
 * database, and every table searched (`subjectProof`). A seed of its own, so the proof's rows never
 * collide with the pass's.
 */
export async function subjectProofFindings(
  subjects: readonly Subject<never>[],
  cores: Readonly<Record<string, EntityCore>>,
  client: DbClient,
  factories?: Readonly<Record<string, SeedFactory>>,
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  // Every subject's graph lands on this one database: each is seeded beside the last written, so a
  // factory value built from the row index never repeats an earlier subject's on a unique column.
  let beside: SeedGraph | undefined;
  for (const [index, subject] of subjects.entries()) {
    // A plan the static half refused is reported there, once; an erase that throws is a finding.
    const problems = await subjectProof(subject, {
      entities: Object.values(cores),
      writer: entitySeedWriter({ entities: cores, client }),
      read: (entity) =>
        client.query<Record<string, unknown>>(sql`select * from ${identifier(entity.$table)}`),
      seed: SUBJECT_PROOF_SEED + index,
      factories,
      beside,
    }).then(
      (result) => {
        beside = result.graph ?? beside;
        return result.problems.filter((p) => p.code === 'X_SUBJECT_ERASE_INCOMPLETE');
      },
      (error: unknown) => (isUltimateError(error) ? [error] : Promise.reject(error)),
    );
    for (const problem of problems) {
      findings.push({
        code: problem.code,
        cause: problem.cause,
        fix: problem.fix,
        at: subject.entity,
      });
    }
  }
  return findings;
}

/** Far from the small seeds a developer passes to `x exercise --seed`. */
const SUBJECT_PROOF_SEED = 0x5ab1ec7;
