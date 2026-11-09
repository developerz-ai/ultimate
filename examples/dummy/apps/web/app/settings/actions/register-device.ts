// `registerDevice`, the settings slice's `pushRegister()` action — one primitive per file, the layout `x g` writes.

import { memberOf } from '@postly/core';
import { pushRegister } from '@ultimat3/notify';
import { pushDevices } from '../native-push';

/**
 * Postly's iOS or Android app, for the member signed in on it. A factory over `action` — its route,
 * typed client and contract tests like any write — storing the token against the member the
 * request ran as. Called on every launch with the token the OS hands the app; when the OS rotated
 * it, `previousToken` names the old one and it is forgotten. An agent is refused whatever it holds.
 */
export const registerDevice = pushRegister({
  permission: 'member:self',
  platforms: ['ios', 'android'],
  devices: pushDevices,
  check: ({ actor }) => memberOf(actor) !== null,
});
