// The push-subscription suite over `postgresPushSubscriptionStore` and a real server
// (`x_push_subscriptions`): the memory run proves the checks, this one proves the statements.

import { describe } from 'bun:test';
import { postgresPushSubscriptionStore } from '@ultimat3/pwa';
import { SQL_PUSH_SUBSCRIPTIONS_TABLE } from '@ultimat3/pwa/schema';
import { CONFORMANCE_ADMIN_URL, conformanceDatabase } from './notify-conformance-pg-fixture';
import { pushSubscriptionStoreConformance } from './push-subscription-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe.skipIf(CONFORMANCE_ADMIN_URL === '')(
  testName('live', 'the postgres push subscription store'),
  () => {
    const pg = conformanceDatabase('ultimate_push_subscription_conformance', [
      SQL_PUSH_SUBSCRIPTIONS_TABLE,
    ]);
    behavesLike(pushSubscriptionStoreConformance, () =>
      postgresPushSubscriptionStore({ executor: pg.executor }),
    );
  },
);
