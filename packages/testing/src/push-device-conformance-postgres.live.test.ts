// The push-device suite over `postgresPushDeviceStore` and a real server (`x_push_devices`): the
// memory run proves the checks, this one proves the statements meet them.

import { describe } from 'bun:test';
import { postgresPushDeviceStore, SQL_PUSH_DEVICES_TABLE } from '@ultimat3/notify';
import { CONFORMANCE_ADMIN_URL, conformanceDatabase } from './notify-conformance-pg-fixture';
import { pushDeviceStoreConformance } from './push-device-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe.skipIf(CONFORMANCE_ADMIN_URL === '')(
  testName('live', 'the postgres push device store'),
  () => {
    const pg = conformanceDatabase('ultimate_push_device_conformance', [SQL_PUSH_DEVICES_TABLE]);
    behavesLike(pushDeviceStoreConformance, () =>
      postgresPushDeviceStore({ executor: pg.executor }),
    );
  },
);
