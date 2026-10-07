// The one structural Postgres seam: `query(text, values)` answering rows. Declared at tier 0 so
// `@ultimat3/http`, `auth`, `action` and `jobs` share it while staying free of `@ultimat3/db` —
// four packages each declared it, and a copy is a fifth place for the contract to drift.

/**
 * One method, positional parameters. **`Bun.sql` does not satisfy it** — `Bun.sql.query` is
 * `undefined`; it is a tagged template whose positional form is `unsafe`, so `{ executor: Bun.sql }`
 * would `TypeError` on the first statement. What satisfies it is a client that already speaks
 * `(text, values)` — `@ultimat3/db`'s `dbExecutor()` over `DbClient.query({ text, values })` is
 * the framework's own, and its one builder — or a transaction
 * handle, which is a client on its own connection. It answers rows, never a command tag.
 */
export interface PgExecutor {
  query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]>;
}
