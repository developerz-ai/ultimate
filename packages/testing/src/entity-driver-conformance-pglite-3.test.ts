// Part 3 of the entity driver suite on PGlite (`entity-driver-conformance-pglite-fixture.ts`): its
// own embedded Postgres, every third check. A file per part so test workers run them side by side.

import { pgliteConformancePart } from './entity-driver-conformance-pglite-fixture';

pgliteConformancePart(2);
