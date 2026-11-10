// The event-bus suite over `postgresEventBus()` and a real Postgres (`TEST_DATABASE_URL`): every
// stamp, expiry and comparison is the database's; time passes by ageing both stamps, never by a
// wait. Every check publishes under names of its own, so they share one `x_job_events`.

import { afterAll, beforeAll, describe } from 'bun:test';
import { postgresEventBus } from '@ultimat3/jobs';
import { eventBusConformance } from './event-bus-conformance';
import { age, jobsDatabase } from './lease-store-conformance-pg-fixture';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the pg event bus'), () => {
  const database = jobsDatabase(adminUrl, 'ultimate_event_conformance');
  beforeAll(database.open);
  afterAll(database.close);

  behavesLike(eventBusConformance, () => ({
    bus: postgresEventBus({ executor: database.executor }),
    elapse: (ms) => age(database, 'x_job_events', ['published_at', 'expires_at'], ms),
  }));
});
