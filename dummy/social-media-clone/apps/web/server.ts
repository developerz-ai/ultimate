// The production entry. `docker/Dockerfile` starts this, and `x build --target binary` compiles it.
// ROLE selects what this process is — web, sync, worker, scheduler, replicator, or migrate, which
// applies the migrations and exits. PORT is bound on every interface, because a container bound to
// localhost is unreachable through its own port mapping.

import { join } from 'node:path';
import { runRole } from '@ultimat3/cli';

/**
 * Where the app is. From this file normally — the image's WORKDIR is not the app root's business.
 * A `--compile` binary is the exception: its `import.meta.dir` is Bun's virtual filesystem, which
 * holds this module's bundled imports and none of the app's source, and the framework's registries
 * are filled by scanning that source at boot. So a binary reads its root from the directory it is
 * started in — it is a launcher for an app tree, not a self-contained copy of one.
 */
const root = import.meta.dir.startsWith('/$bunfs')
  ? process.cwd()
  : join(import.meta.dir, '..', '..');

// Guarded, because the framework's module scan imports every file under apps/*/ to fill its
// registries — an unguarded boot would start a server inside `x verify`.
if (import.meta.main) {
  await runRole({ root, env: Bun.env });
}
