// `@ultimat3/cli/serve`: what a container's `apps/web/server.ts` imports, and nothing else. The
// `@ultimat3/cli` barrel is 1,349 modules — every command, every template, the e2e driver — and a
// production process that booted through it loaded all of them to call one function.

export { runRole } from './serve';
export type { MigratedApp, ServedApp, ServeOptions, StartedApp } from './serve-types';
