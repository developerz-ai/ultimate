// What every group of `authAdapterConformance` shares: the subject (an adapter and the frozen
// clock it stamps from), the check shape, and users minted under ids and addresses no other check
// or run holds — a shared database keeps every check's rows, so none may read a neighbour's.

import type { AuthAdapter, CreateUserInput } from '@ultimat3/auth';
import type { FrozenClock } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';

/** The adapter under test, and the clock it was built with — every instant it stamps is this one's. */
export interface AuthAdapterSubject {
  readonly adapter: AuthAdapter;
  readonly clock: FrozenClock;
}

export interface AuthAdapterCheck {
  readonly name: string;
  run(subject: AuthAdapterSubject): Promise<void>;
}

export const CREATED_AT = new Date('2026-08-09T12:00:00.000Z');

/** A user id: the Postgres column is `uuid`. */
export const userId = (): string => crypto.randomUUID();

/** An address unique to this call, its local part starting with `label` so order is the label's. */
export const emailOf = (label: string): string => `${label}-${crypto.randomUUID()}@example.com`;

/** A text id no other check, run or process shares. */
export const idOf = (label: string): string => `conformance-${label}-${crypto.randomUUID()}`;

export const userInput = (
  id: string,
  email: string,
  extra: Partial<CreateUserInput> = {},
): CreateUserInput => ({
  id,
  email,
  passwordHash: null,
  orgId: null,
  roles: [],
  createdAt: CREATED_AT,
  ...extra,
});

/** Create a user and answer its id. */
export const seedUser = async (
  adapter: AuthAdapter,
  extra: Partial<CreateUserInput> = {},
): Promise<string> => {
  const id = userId();
  await adapter.createUser(userInput(id, emailOf('user'), extra));
  return id;
};

/** What a refused write answered: `<code> <meta.operation> <meta.column>`, or `did-not-throw`. */
export const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (!isUltimateError(error)) return 'not-an-UltimateError';
    return `${error.code} ${String(error.meta?.['operation'])} ${String(error.meta?.['column'])}`;
  }
  return 'did-not-throw';
};

/** Only the rows a check wrote, from a list a shared store fills with everyone's. */
export const own = <T>(
  rows: readonly T[],
  ids: readonly string[],
  idOfRow: (row: T) => string,
): readonly T[] => rows.filter((row) => ids.includes(idOfRow(row)));
