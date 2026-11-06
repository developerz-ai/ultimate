// Who a partner token is: a client-credentials grant acts as a service holding its granted scopes;
// a grant whose subject is a person opens nothing on the partner mount.
import { expect, unitTest } from '@ultimat3/testing';
import { PARTNER_SCOPES, partnerActor, partnerOAuth } from './oauth';

const grant = (subject: string) => ({
  subject,
  clientId: 'c_partner',
  scopes: new Set(['posts:read']),
  resource: null,
});

unitTest('a client-credentials grant is a service with exactly its scopes', () => {
  const actor = partnerActor(grant('c_partner'));
  expect(actor).toMatchObject({ kind: 'service', id: 'partner:c_partner', scopes: ['posts:read'] });
  expect(actor?.orgId).toBeUndefined();
});

unitTest('a grant for a person is refused here', () => {
  expect(partnerActor(grant('usr-ada'))).toBeNull();
});

unitTest('the server grants exactly the mount’s scopes, by client_credentials alone', () => {
  expect(partnerOAuth.metadata).toMatchObject({
    scopes_supported: Object.keys(PARTNER_SCOPES).sort(),
    grant_types_supported: ['client_credentials'],
  });
});
