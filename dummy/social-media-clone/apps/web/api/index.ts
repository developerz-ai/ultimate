// Registration. Importing this module IS the boot: the framework's module scan walks the surface
// directories and every declaration registers as a side effect of being imported.
//
// It also seeds. That is an APP decision, not a framework one, and it is the right one for a public
// demo: the store behind `x dev` is in-process, so a seed run from a second process would populate
// a database nobody reads. Seeding here means the demo shows the same content on every boot, which
// is also what makes the hourly reset a no-op rather than a special case.
//
// It is a REPLAY, on every role and every restart: web, sync, worker and scheduler each run this on
// the way up, against one shared Postgres once `DATABASE_URL` is set. It is replayable by
// construction: `defineSeed`'s `insert` is ONE `on conflict do nothing` upsert per call
// (packages/entity/src/seed.ts:274), not a plain insert — the claim "the rows are already there and
// this call does nothing" lived here while the call was a plain insert, which is `23505` on the
// second container to boot. `ROLE=migrate` applies migrations and does NOT seed: the framework's
// release phase runs no app code.

import { seedDemo } from '@social-media-clone/db';

await seedDemo();
