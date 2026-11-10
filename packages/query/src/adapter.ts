// `@ultimat3/query/adapter` — what a test harness reaches beside the barrel: the rows-override seam
// `@ultimat3/testing`'s `stub(query)` installs. Never the `.` barrel: an app module cannot answer a
// read with rows its `sql()` did not produce.

export type { QueryClient, QueryClientOptions } from './client';
export { overrideRows } from './read';
export type { RowsOverride } from './rows-override';
