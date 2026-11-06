// health, called: what a probe gets back. Its projections — the OpenAPI operation and the MCP
// tool — are the contract suite's, next door.
import { anonymousActor, resolveRole } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import { health } from './health';

const target = health.named('health');

unitTest('health answers ok and the role of this process, with no session', async () => {
  // Anonymous on purpose: a load balancer has no session, and `allow('public')` is what lets it
  // in. The role is the process's own (`ROLE`), which is what tells a web probe from a worker's.
  expect(await target.as(anonymousActor(), {})).toEqual({ ok: true, role: resolveRole() });
});
