// Registration. Importing this module IS the boot: the framework's module scan walks the surface
// directories and every declaration registers as a side effect of being imported.
//
// It also seeds. That is an APP decision, not a framework one, and it is the right one for a public
// demo: the store behind `x dev` is in-process, so a seed run from a second process would populate
// a database nobody reads. Seeding here means the demo shows the same content on every boot, which
// is also what makes the hourly reset a no-op rather than a special case.
//
// A real deployment against Postgres seeds through `ROLE=migrate` instead — the rows are already
// there, and this call finds them and does nothing.

import { seedDemo } from '@social-media-clone/db';

await seedDemo();
