// Single responsibility: a `DbClient` that records instead of connecting. Every test in this
// package — and every app test that wants to assert "the action wrote one row" — runs against it
// via `setDbClient()`. Recording the exact text and values is what makes migration, transaction
// and drift behaviour assertable with no database and no Docker.

import type { DbClient } from './client';
import type { SqlFragment } from './sql';

export interface RecordedStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface StubResponse {
  readonly rows?: readonly unknown[] | undefined;
  readonly affected?: number | undefined;
}

export interface RecordingClient extends DbClient {
  readonly statements: readonly RecordedStatement[];
  /** Statement texts with runs of whitespace collapsed — what assertions actually match on. */
  readonly texts: readonly string[];
  /** Later registrations win, so a test can narrow a general stub. */
  on(match: string | RegExp, response: StubResponse): RecordingClient;
  reset(): void;
}

interface Stub {
  readonly match: string | RegExp;
  readonly response: StubResponse;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

function matches(stub: Stub, text: string): boolean {
  return typeof stub.match === 'string' ? text.includes(stub.match) : stub.match.test(text);
}

export function createRecordingClient(): RecordingClient {
  const statements: RecordedStatement[] = [];
  const stubs: Stub[] = [];

  function respond(fragment: SqlFragment): StubResponse {
    statements.push({ text: fragment.text, values: [...fragment.values] });
    const text = squash(fragment.text);
    for (let index = stubs.length - 1; index >= 0; index -= 1) {
      const stub = stubs[index];
      if (stub !== undefined && matches(stub, text)) return stub.response;
    }
    return {};
  }

  const client: RecordingClient = {
    statements,
    get texts(): readonly string[] {
      return statements.map((statement) => squash(statement.text));
    },
    on(match: string | RegExp, response: StubResponse): RecordingClient {
      stubs.push({ match, response });
      return client;
    },
    reset(): void {
      statements.length = 0;
      stubs.length = 0;
    },
    async query<T>(fragment: SqlFragment): Promise<readonly T[]> {
      return (respond(fragment).rows ?? []) as readonly T[];
    },
    async one<T>(fragment: SqlFragment): Promise<T | null> {
      const rows = respond(fragment).rows ?? [];
      return (rows[0] as T | undefined) ?? null;
    },
    async execute(fragment: SqlFragment): Promise<number> {
      const response = respond(fragment);
      return response.affected ?? response.rows?.length ?? 0;
    },
  };
  return client;
}
