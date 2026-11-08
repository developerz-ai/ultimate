// The user an exercise actor IS: one `x_users` row per actor the pass acts as, written before the
// call, so a handler reading its caller through `@ultimat3/auth` (`findUserById(ctx.actor.id)`)
// finds the row production always has. Only where the table exists — the framework schema every
// `x exercise` database is built with — and only for an actor whose id has a user's shape.

import type { Actor } from '@ultimat3/core';
import { isUltimateError, renderThrowable, UltimateError } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `x_users` exists on this client, asked once per client: the schema does not move. */
const hasUsers = new WeakMap<DbClient, Promise<boolean>>();

/** The insert was refused: the pass cannot act as a user it could not create. */
export class ExerciseActorUserUnseatedError extends UltimateError {
  constructor(error: unknown) {
    super({
      code: 'X_EXERCISE_ACTOR_USER_UNSEATED',
      cause: `x exercise writes one x_users row per actor it acts as, and the insert was refused: ${isUltimateError(error) ? error.cause : renderThrowable(error)}`,
      fix: 'give the added x_users column a default or make it nullable in its migration under packages/db/migrations/, then x exercise --json',
      sourceError: error,
    });
  }
}

/**
 * Seat every actor in `actors` as an `x_users` row: id, a reserved `.invalid` address unique per
 * id, its tenant, roles, permissions and scopes. Idempotent (`on conflict (id) do nothing`), so
 * the same role in the same tenant — one id, `exerciseActorId` — is written once however often the
 * pass acts as it. No installed client, no table, no uuid: nothing to seat, nothing written.
 */
export async function seatActorUsers(actors: readonly (Actor | null)[]): Promise<void> {
  const users = [
    ...new Map(
      actors.filter((a): a is Actor => a !== null && UUID.test(a.id)).map((a) => [a.id, a]),
    ).values(),
  ];
  if (users.length === 0) return;
  const { db, dbClientInstalled, sql } = await import('@ultimat3/db');
  if (!dbClientInstalled()) return;
  const client = db();
  let known = hasUsers.get(client);
  if (known === undefined) {
    known = client
      .one<{ found: boolean }>(sql`select to_regclass('x_users') is not null as found`)
      .then((row) => row?.found === true);
    hasUsers.set(client, known);
  }
  if (!(await known)) return;
  for (const user of users) {
    const org = typeof user.orgId === 'string' && UUID.test(user.orgId) ? user.orgId : null;
    try {
      await client.execute(sql`
        insert into x_users (id, email, org_id, roles, permissions, scopes)
        values (${user.id}, ${`${user.id}@exercise.invalid`}, ${org}, ${[...(user.roles ?? [])]},
                ${[...(user.permissions ?? [])]}, ${[...(user.scopes ?? [])]})
        on conflict (id) do nothing`);
    } catch (error) {
      throw new ExerciseActorUserUnseatedError(error);
    }
  }
}
