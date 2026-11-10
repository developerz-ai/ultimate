// `@ultimat3/db/adapter` — the seam a driver or host wires, never the app API: the connection
// options and client shapes a Postgres/PGlite driver implements, the boot's default client and the
// PGlite loader. App code reads `db()` from `.`; this entry is for whoever installs the client.

export type { PostgresClientOptions, ReservableClient } from './client';
export { defaultClient } from './default-client';
export type { ListeningClient } from './listen';
export { loadPgliteDriver } from './pglite';
export type { ReplicatedClientOptions } from './replica-client';
