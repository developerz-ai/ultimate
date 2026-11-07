// The production entry. `docker/Dockerfile` starts this, and `x build --target binary` compiles it.
// ROLE selects what this process is — web, sync, worker, scheduler, replicator, or migrate, which
// applies the migrations and exits. PORT is bound on HOST, and HOST defaults to every interface,
// because a container bound to loopback is unreachable through its own port mapping. HOST=127.0.0.1
// is for a process that must never answer a public interface: reachable only where the container
// shares the host's network namespace (`--network host`), or through a sidecar and `ssh -L`.

import { join } from 'node:path';
import { runRole } from '@ultimat3/cli/serve';
import { isCompiledBundle } from '@ultimat3/core';

// MORE THAN ONE REPLICA? Add these two lines, above `runRole`:
//
//   import { configureIdempotency } from '@ultimat3/action';
//   configureIdempotency({ scope: 'shared' });
//
// `idempotent: true` on an action promises that a retry does not repeat the work. Under the
// process-scoped default that promise holds inside ONE process — a client retrying
// `POST /api/payments/charge` after a timeout lands on another replica, which has never seen the
// key, and charges the card twice, silently, with `x verify` green. Declaring `'shared'` is what
// makes that a boot error (`X_IDEMPOTENCY_NOT_SHARED`) unless a shared store is installed.
// `runRole` installs the Postgres one for you, on the connection it resolved from `DATABASE_URL`,
// so the declaration is all this app owes. It must run before `runRole` imports the actions.

/**
 * Where the app is. From this file normally — the image's WORKDIR is not the app root's business.
 * A `--compile` binary is the exception: its `import.meta.dir` is Bun's virtual filesystem, which
 * holds this module's bundled imports and none of the app's source, and the framework's registries
 * are filled by scanning that source at boot. So a binary reads its root from the directory it is
 * started in — it is a launcher for an app tree, not a self-contained copy of one.
 * `isCompiledBundle` knows both spellings of that filesystem: `/$bunfs/` on Linux and macOS,
 * `B:\~BUN\` on Windows.
 */
const root = isCompiledBundle(import.meta.dir) ? process.cwd() : join(import.meta.dir, '..', '..');

// Guarded, because the framework's module scan imports every file under apps/*/ to fill its
// registries — an unguarded boot would start a server inside `x verify`.
if (import.meta.main) {
  await runRole({ root, env: Bun.env });
}
