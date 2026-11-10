// The subject proof under the `exercise` step. Static: every `defineSubject()` planned against
// every registered entity: an untreated subject table is `X_SUBJECT_TABLE_UNDECLARED`; a
// `.personalData()` column an erase would leave, or a marked table no subject reaches, is red too.
// Dynamic: `subjectProof` erases one generated person and searches every table for them.

import { isUltimateError } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { identifier, sql } from '@ultimat3/db';
import type { EntityCore, PersonalDataEntity, RegistryEntry } from '@ultimat3/entity';
import { personalDataOf } from '@ultimat3/entity';
import type { Subject, SubjectPlan } from '@ultimat3/jobs';
import { planSubject, unerasedPersonalData, unreachedPersonalData } from '@ultimat3/jobs';
import type { SeedFactory, SeedGraph } from '@ultimat3/testing';
import { entitySeedWriter, subjectProof } from '@ultimat3/testing';
import type { Finding } from './output';

export function subjectFindings(
  subjects: readonly Subject<never>[],
  entries: readonly RegistryEntry[],
): readonly Finding[] {
  const findings: Finding[] = [];
  const plans: SubjectPlan[] = [];
  const push = (problem: unknown, at: string): void => {
    if (isUltimateError(problem)) {
      findings.push({ code: problem.code, cause: problem.cause, fix: problem.fix, at });
    }
  };
  for (const subject of subjects) {
    const { plan, problems } = planSubject({
      subject: subject.entity,
      tables: subject.init.tables,
      columns: subject.init.columns,
      entries,
    });
    for (const problem of problems) push(problem, subject.entity);
    // A refused plan's reach is not known: its coverage is not a question with an answer.
    if (problems.length > 0) continue;
    plans.push(plan);
  }
  // `.personalData()` coverage (`@ultimat3/jobs`' `gdpr-coverage.ts`), over the same entries.
  const marked = markedOf(entries);
  for (const plan of plans) {
    for (const leak of unerasedPersonalData(plan, marked)) push(leak, plan.subject);
  }
  for (const lost of unreachedPersonalData(plans, marked)) push(lost, String(lost.meta?.['table']));
  return findings;
}

/** The entries carrying `.personalData()` columns, as `personalDataEntities()` shapes them. */
const markedOf = (entries: readonly RegistryEntry[]): readonly PersonalDataEntity[] =>
  entries.flatMap((entry) => {
    const core = entry.core;
    const columns = core === undefined ? [] : personalDataOf(core);
    return core === undefined || columns.length === 0
      ? []
      : [{ entity: core, tenantColumn: core.$tenantColumn, columns }];
  });

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
