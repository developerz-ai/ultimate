// `unregisterDevice`, the settings slice's `pushUnregister()` action — one primitive per file, the layout `x g` writes.

import { memberOf } from '@postly/core';
import { pushUnregister } from '@ultimat3/notify';
import { pushDevices } from '../native-push';

/** Signing out of the app forgets its token — the caller's own registration only. */
export const unregisterDevice = pushUnregister({
  permission: 'member:self',
  platforms: ['ios', 'android'],
  devices: pushDevices,
  check: ({ actor }) => memberOf(actor) !== null,
});
